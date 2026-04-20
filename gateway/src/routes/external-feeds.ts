import type { FastifyInstance } from 'fastify'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { requireAdmin } from './moderation.js'
import logger from '@platform-pub/shared/lib/logger.js'

// Per-protocol validation for subscribe input. Returns null if valid, or a
// human-readable error message.
function validateSubscribeInput(input: {
  protocol: string
  sourceUri: string
  displayName?: string
  description?: string
  avatarUrl?: string
  relayUrls?: string[]
}): string | null {
  const { protocol, sourceUri, displayName, description, avatarUrl, relayUrls } = input

  if (typeof sourceUri !== 'string' || sourceUri.length === 0 || sourceUri.length > 2048) {
    return 'sourceUri must be 1–2048 chars'
  }

  if (protocol === 'rss') {
    try {
      const u = new URL(sourceUri)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'rss sourceUri must be http(s)'
    } catch { return 'rss sourceUri must be a valid URL' }
  } else if (protocol === 'activitypub') {
    try {
      const u = new URL(sourceUri)
      if (u.protocol !== 'https:') return 'activitypub sourceUri must be https'
    } catch { return 'activitypub sourceUri must be a valid URL' }
  } else if (protocol === 'atproto') {
    if (!/^did:(plc|web):[a-zA-Z0-9.:_-]+$/.test(sourceUri)) {
      return 'atproto sourceUri must be a DID (did:plc:… or did:web:…)'
    }
  } else if (protocol === 'nostr_external') {
    if (!/^[0-9a-f]{64}$/i.test(sourceUri)) {
      return 'nostr_external sourceUri must be a 64-char hex pubkey'
    }
  }

  // Strip control chars and cap free-text fields
  if (displayName != null && (typeof displayName !== 'string' || displayName.length > 200)) {
    return 'displayName exceeds 200 chars'
  }
  if (description != null && (typeof description !== 'string' || description.length > 1000)) {
    return 'description exceeds 1000 chars'
  }
  if (avatarUrl != null && avatarUrl.length > 0) {
    if (typeof avatarUrl !== 'string' || avatarUrl.length > 2048) return 'avatarUrl exceeds 2048 chars'
    try {
      const u = new URL(avatarUrl)
      if (u.protocol !== 'https:') return 'avatarUrl must be https'
    } catch { return 'avatarUrl must be a valid URL' }
  }

  if (relayUrls != null) {
    if (!Array.isArray(relayUrls)) return 'relayUrls must be an array'
    if (relayUrls.length > 10) return 'relayUrls exceeds 10 entries'
    for (const r of relayUrls) {
      if (typeof r !== 'string' || r.length === 0 || r.length > 2048) {
        return 'each relayUrl must be a 1–2048 char string'
      }
      try {
        const u = new URL(r)
        if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return 'relayUrls must use ws:// or wss://'
      } catch { return `invalid relayUrl: ${r}` }
    }
  }

  return null
}

function stripControlChars(s: string | undefined | null): string | null {
  if (s == null) return null
  return s.replace(/[\x00-\x1f\x7f]/g, '').trim() || null
}

// =============================================================================
// External Feed Subscription routes
//
// POST   /feeds/subscribe      — Subscribe to an external source
// GET    /feeds                 — List user's subscriptions
// DELETE /feeds/:id             — Remove a subscription
// PATCH  /feeds/:id             — Update subscription preferences
// POST   /feeds/:id/refresh     — Force immediate re-fetch
// =============================================================================

export async function externalFeedsRoutes(app: FastifyInstance) {

  // POST /feeds/subscribe — subscribe to an external source
  app.post<{
    Body: {
      protocol: 'rss' | 'atproto' | 'activitypub' | 'nostr_external'
      sourceUri: string
      displayName?: string
      description?: string
      avatarUrl?: string
      relayUrls?: string[]
    }
  }>('/feeds/subscribe', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const readerId = req.session!.sub!
    const { protocol, sourceUri, displayName, description, avatarUrl, relayUrls } = req.body ?? {}

    if (!protocol || !sourceUri) {
      return reply.status(400).send({ error: 'protocol and sourceUri are required' })
    }

    if (protocol !== 'rss' && protocol !== 'atproto' && protocol !== 'nostr_external' && protocol !== 'activitypub') {
      return reply.status(400).send({ error: `Protocol "${protocol}" is not yet supported.` })
    }

    const validationError = validateSubscribeInput({ protocol, sourceUri, displayName, description, avatarUrl, relayUrls })
    if (validationError) {
      return reply.status(400).send({ error: validationError })
    }

    const { rows: [limitRow] } = await pool.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'max_subscriptions_per_user'`
    )
    const maxSubs = parseInt(limitRow?.value ?? '200', 10)

    try {
      const result = await withTransaction(async (client) => {
        // Serialize concurrent subscribe requests from the same user so the
        // count-then-insert below is atomic w.r.t. other replicas. Without
        // this, two racing requests both observe count < max and both insert,
        // letting a user slip past the cap.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('feed_sub:' || $1::text))`, [readerId])
        const { rows: [{ count: subCount }] } = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM external_subscriptions WHERE subscriber_id = $1`,
          [readerId]
        )
        if (parseInt(subCount, 10) >= maxSubs) {
          // Tagged error so the outer handler can return a proper 429.
          const err: Error & { code?: string } = new Error('limit_exceeded')
          err.code = 'SUB_LIMIT_EXCEEDED'
          throw err
        }

        // Upsert external_sources (shared across subscribers)
        const { rows: [source] } = await client.query<{ id: string }>(`
          INSERT INTO external_sources (protocol, source_uri, display_name, description, avatar_url, relay_urls)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (protocol, source_uri) DO UPDATE SET
            display_name = COALESCE(NULLIF($3, ''), external_sources.display_name),
            description = COALESCE(NULLIF($4, ''), external_sources.description),
            avatar_url  = COALESCE(NULLIF($5, ''), external_sources.avatar_url),
            relay_urls  = COALESCE($6, external_sources.relay_urls),
            is_active = TRUE,
            orphaned_at = NULL,
            updated_at = now()
          RETURNING id
        `, [
          protocol, sourceUri,
          stripControlChars(displayName),
          stripControlChars(description),
          avatarUrl ?? null,
          protocol === 'nostr_external' && relayUrls && relayUrls.length > 0 ? relayUrls : null,
        ])

        // Create subscription (idempotent)
        const { rows: [sub] } = await client.query<{ id: string }>(`
          INSERT INTO external_subscriptions (subscriber_id, source_id)
          VALUES ($1, $2)
          ON CONFLICT (subscriber_id, source_id) DO UPDATE SET
            is_muted = FALSE
          RETURNING id
        `, [readerId, source.id])

        return { sourceId: source.id, subscriptionId: sub.id }
      })

      // Enqueue an immediate fetch job for protocols that poll. atproto
      // sources are picked up by the Jetstream listener's next 60s DID
      // refresh — no per-subscribe job needed (backfill of prior history
      // is a separate, out-of-band concern).
      const fetchTask = protocol === 'rss'
        ? 'feed_ingest_rss'
        : protocol === 'nostr_external'
          ? 'feed_ingest_nostr'
          : protocol === 'atproto'
            ? 'feed_ingest_atproto_backfill'
            : protocol === 'activitypub'
              ? 'feed_ingest_activitypub'
              : null
      if (fetchTask) {
        await pool.query(`
          SELECT graphile_worker.add_job(
            $2,
            json_build_object('sourceId', $1::text),
            job_key := 'feed_ingest_' || $1::text,
            max_attempts := 1
          )
        `, [result.sourceId, fetchTask])
      }

      return reply.status(201).send({
        subscriptionId: result.subscriptionId,
        sourceId: result.sourceId,
      })
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'SUB_LIMIT_EXCEEDED') {
        return reply.status(429).send({ error: `Subscription limit reached (max ${maxSubs})` })
      }
      logger.error({ err, protocol, sourceUri }, 'Subscribe failed')
      return reply.status(500).send({ error: 'Subscription failed' })
    }
  })

  // GET /feeds — list user's external subscriptions
  app.get('/feeds', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const readerId = req.session!.sub!

    const { rows } = await pool.query(`
      SELECT
        es.id AS subscription_id,
        es.is_muted,
        es.daily_cap,
        es.created_at AS subscribed_at,
        src.id AS source_id,
        src.protocol,
        src.source_uri,
        src.display_name,
        src.avatar_url,
        src.description,
        src.is_active,
        src.error_count,
        src.last_error,
        src.last_fetched_at,
        (SELECT COUNT(*) FROM external_items ei WHERE ei.source_id = src.id AND ei.deleted_at IS NULL) AS item_count
      FROM external_subscriptions es
      JOIN external_sources src ON src.id = es.source_id
      WHERE es.subscriber_id = $1
      ORDER BY es.created_at DESC
    `, [readerId])

    return reply.send({
      subscriptions: rows.map(row => ({
        id: row.subscription_id,
        isMuted: row.is_muted,
        dailyCap: row.daily_cap,
        subscribedAt: row.subscribed_at,
        source: {
          id: row.source_id,
          protocol: row.protocol,
          sourceUri: row.source_uri,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          description: row.description,
          isActive: row.is_active,
          errorCount: row.error_count,
          lastError: row.last_error,
          lastFetchedAt: row.last_fetched_at,
          itemCount: parseInt(row.item_count, 10),
        },
      })),
    })
  })

  // DELETE /feeds/:id — remove a subscription
  app.delete<{ Params: { id: string } }>('/feeds/:id', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const readerId = req.session!.sub!
    const { id } = req.params

    // Capture source_id so we can opportunistically mark the source as
    // orphaned in the same transaction. external_sources_gc also catches
    // missed stamps via its Phase 0, so a race that skips this update
    // only delays deactivation by one GC cycle.
    const { rows } = await pool.query<{ source_id: string }>(
      `DELETE FROM external_subscriptions
        WHERE id = $1 AND subscriber_id = $2
        RETURNING source_id`,
      [id, readerId]
    )

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Subscription not found' })
    }

    await pool.query(
      `UPDATE external_sources
          SET orphaned_at = now()
        WHERE id = $1
          AND orphaned_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM external_subscriptions WHERE source_id = $1
          )`,
      [rows[0].source_id]
    )

    return reply.send({ ok: true })
  })

  // PATCH /feeds/:id — update subscription preferences
  app.patch<{
    Params: { id: string }
    Body: { isMuted?: boolean; dailyCap?: number | null }
  }>('/feeds/:id', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const readerId = req.session!.sub!
    const { id } = req.params
    const { isMuted, dailyCap } = req.body ?? {}

    const updates: string[] = []
    const params: any[] = [id, readerId]
    let idx = 3

    if (isMuted !== undefined) {
      updates.push(`is_muted = $${idx}`)
      params.push(isMuted)
      idx++
    }
    if (dailyCap !== undefined) {
      updates.push(`daily_cap = $${idx}`)
      params.push(dailyCap)
      idx++
    }

    if (updates.length === 0) {
      return reply.status(400).send({ error: 'No fields to update' })
    }

    const { rowCount } = await pool.query(
      `UPDATE external_subscriptions SET ${updates.join(', ')} WHERE id = $1 AND subscriber_id = $2`,
      params
    )

    if (!rowCount || rowCount === 0) {
      return reply.status(404).send({ error: 'Subscription not found' })
    }

    return reply.send({ ok: true })
  })

  // GET /admin/activitypub/instance-health — per-instance ingest stats
  //
  // Exposes the counters maintained by feed_ingest_activitypub so admins can
  // spot unreliable Mastodon instances and inform the ADR's §XII.5 decision
  // on whether to accelerate inbox delivery.
  app.get('/admin/activitypub/instance-health', {
    preHandler: requireAdmin,
  }, async (_req, reply) => {
    const { rows } = await pool.query<{
      host: string
      success_count: string
      failure_count: string
      last_success_at: Date | null
      last_failure_at: Date | null
      last_error: string | null
      subscribed_sources: string
    }>(`
      SELECT
        h.host,
        h.success_count,
        h.failure_count,
        h.last_success_at,
        h.last_failure_at,
        h.last_error,
        (
          SELECT COUNT(*)::text FROM external_sources s
          WHERE s.protocol = 'activitypub'
            AND s.is_active = TRUE
            AND split_part(
              replace(replace(s.source_uri, 'https://', ''), 'http://', ''),
              '/', 1
            ) = h.host
        ) AS subscribed_sources
      FROM activitypub_instance_health h
      ORDER BY (h.success_count + h.failure_count) DESC
      LIMIT 200
    `)
    return reply.send({
      instances: rows.map(r => {
        const s = parseInt(r.success_count, 10)
        const f = parseInt(r.failure_count, 10)
        const total = s + f
        return {
          host: r.host,
          successCount: s,
          failureCount: f,
          successRate: total === 0 ? null : s / total,
          lastSuccessAt: r.last_success_at,
          lastFailureAt: r.last_failure_at,
          lastError: r.last_error,
          subscribedSources: parseInt(r.subscribed_sources, 10),
        }
      }),
    })
  })

  // POST /feeds/:id/refresh — force immediate re-fetch
  //
  // Rate-limited: manual refresh is a nice-to-have, but unbounded it's a
  // cheap way to pin a feed-ingest worker doing back-to-back RSS/Mastodon/
  // Nostr fetches against the same upstream. 6/min/user gives reasonable
  // interactive feel (refresh a few tabs in a row) without allowing abuse.
  app.post<{ Params: { id: string } }>('/feeds/:id/refresh', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const readerId = req.session!.sub!
    const { id } = req.params

    const { rows } = await pool.query<{ source_id: string; protocol: string }>(
      `SELECT es.source_id, src.protocol
       FROM external_subscriptions es
       JOIN external_sources src ON src.id = es.source_id
       WHERE es.id = $1 AND es.subscriber_id = $2`,
      [id, readerId]
    )

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Subscription not found' })
    }

    const { source_id, protocol } = rows[0]

    const refreshTask = protocol === 'rss' ? 'feed_ingest_rss'
                      : protocol === 'nostr_external' ? 'feed_ingest_nostr'
                      : protocol === 'activitypub' ? 'feed_ingest_activitypub'
                      : protocol === 'atproto' ? 'feed_ingest_atproto_backfill'
                      : null
    if (refreshTask) {
      await pool.query(`
        SELECT graphile_worker.add_job(
          $2,
          json_build_object('sourceId', $1::text),
          job_key := 'feed_ingest_' || $1::text,
          max_attempts := 1
        )
      `, [source_id, refreshTask])
    }

    return reply.send({ ok: true })
  })
}
