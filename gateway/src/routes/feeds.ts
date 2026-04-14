import type { FastifyInstance } from 'fastify'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// External Feed Subscription routes
//
// POST   /feeds/subscribe      — Subscribe to an external source
// GET    /feeds                 — List user's subscriptions
// DELETE /feeds/:id             — Remove a subscription
// PATCH  /feeds/:id             — Update subscription preferences
// POST   /feeds/:id/refresh     — Force immediate re-fetch
// =============================================================================

export async function feedsRoutes(app: FastifyInstance) {

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

    if (protocol !== 'rss' && protocol !== 'atproto' && protocol !== 'nostr_external') {
      return reply.status(400).send({ error: `Protocol "${protocol}" is not yet supported.` })
    }

    // Check subscription limit
    const { rows: [{ count: subCount }] } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM external_subscriptions WHERE subscriber_id = $1`,
      [readerId]
    )
    const { rows: [limitRow] } = await pool.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'max_subscriptions_per_user'`
    )
    const maxSubs = parseInt(limitRow?.value ?? '200', 10)
    if (parseInt(subCount, 10) >= maxSubs) {
      return reply.status(429).send({ error: `Subscription limit reached (max ${maxSubs})` })
    }

    try {
      const result = await withTransaction(async (client) => {
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
            updated_at = now()
          RETURNING id
        `, [
          protocol, sourceUri,
          displayName ?? null,
          description ?? null,
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

    const { rowCount } = await pool.query(
      `DELETE FROM external_subscriptions WHERE id = $1 AND subscriber_id = $2`,
      [id, readerId]
    )

    if (!rowCount || rowCount === 0) {
      return reply.status(404).send({ error: 'Subscription not found' })
    }

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

  // POST /feeds/:id/refresh — force immediate re-fetch
  app.post<{ Params: { id: string } }>('/feeds/:id/refresh', {
    preHandler: requireAuth,
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

    if (protocol === 'rss') {
      await pool.query(`
        SELECT graphile_worker.add_job(
          'feed_ingest_rss',
          json_build_object('sourceId', $1::text),
          job_key := 'feed_ingest_' || $1::text,
          max_attempts := 1
        )
      `, [source_id])
    }

    return reply.send({ ok: true })
  })
}
