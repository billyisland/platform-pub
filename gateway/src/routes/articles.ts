import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { WebSocket } from 'ws'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import { checkArticleAccess, recordSubscriptionRead, recordPurchaseUnlock } from '../services/access.js'
import { signEvent } from '../../shared/src/auth/keypairs.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Article Routes
//
// POST /articles                          — Index a published article in the DB
// GET  /articles/:dTag                    — Fetch article metadata by d-tag
// POST /articles/:nostrEventId/vault      — Proxy to key service (vault create)
// PATCH /articles/:nostrEventId/vault     — Proxy to key service (vault ID update)
// POST /articles/:nostrEventId/key        — Proxy to key service (key issuance)
// POST /articles/:nostrEventId/gate-pass  — Record gate pass + proxy to payment
//
// The gateway adds auth headers and proxies to internal services.
// This is the single surface the web client talks to.
// =============================================================================

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL ?? 'http://localhost:3002'
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:3001'

const IndexArticleSchema = z.object({
  nostrEventId: z.string().min(1),
  dTag: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),                // free section content
  isPaywalled: z.boolean(),
  pricePence: z.number().int().min(0),
  gatePositionPct: z.number().int().min(0).max(99),
  vaultEventId: z.string().optional(),
})

export async function articleRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /articles — index a published article in the platform database
  //
  // Called by the publishing pipeline after the NIP-23 event is on the relay.
  // Creates the app-layer index row used for feed assembly, search, billing.
  // ---------------------------------------------------------------------------

  app.post('/articles', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = IndexArticleSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const writerId = req.session!.sub!
    const data = parsed.data

    // Generate slug from title
    const slug = data.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 120)

    // Count words
    const wordCount = data.content.split(/\s+/).filter(Boolean).length

    try {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO articles (
           writer_id, nostr_event_id, nostr_d_tag, title, slug,
           content_free, word_count, tier,
           is_paywalled, price_pence, gate_position_pct, vault_event_id,
           published_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'tier1', $8, $9, $10, $11, now())
         ON CONFLICT (nostr_event_id) DO UPDATE SET
           title = EXCLUDED.title,
           content_free = EXCLUDED.content_free,
           word_count = EXCLUDED.word_count,
           is_paywalled = EXCLUDED.is_paywalled,
           price_pence = EXCLUDED.price_pence,
           gate_position_pct = EXCLUDED.gate_position_pct,
           vault_event_id = EXCLUDED.vault_event_id,
           updated_at = now()
         RETURNING id`,
        [
          writerId,
          data.nostrEventId,
          data.dTag,
          data.title,
          slug,
          data.content,
          wordCount,
          data.isPaywalled,
          data.isPaywalled ? data.pricePence : null,
          data.isPaywalled ? data.gatePositionPct : null,
          data.vaultEventId ?? null,
        ]
      )

      logger.info(
        { articleId: result.rows[0].id, writerId, nostrEventId: data.nostrEventId },
        'Article indexed'
      )

      return reply.status(201).send({ articleId: result.rows[0].id })
    } catch (err) {
      logger.error({ err, writerId }, 'Article indexing failed')
      return reply.status(500).send({ error: 'Indexing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /articles/:dTag — fetch article metadata by d-tag
  //
  // Public endpoint for the article reader page. Returns metadata from the
  // DB index; the full content comes from the relay (NIP-23 event).
  // ---------------------------------------------------------------------------

  app.get<{ Params: { dTag: string } }>(
    '/articles/:dTag',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { dTag } = req.params

      const { rows } = await pool.query<{
        id: string
        writer_id: string
        nostr_event_id: string
        nostr_d_tag: string
        title: string
        slug: string
        summary: string | null
        word_count: number | null
        is_paywalled: boolean
        price_pence: number | null
        gate_position_pct: number | null
        vault_event_id: string | null
        published_at: Date | null
        writer_username: string
        writer_display_name: string | null
        writer_avatar: string | null
        writer_pubkey: string
      }>(
        `SELECT a.id, a.writer_id, a.nostr_event_id, a.nostr_d_tag,
                a.title, a.slug, a.summary, a.word_count,
                a.is_paywalled, a.price_pence, a.gate_position_pct,
                a.vault_event_id, a.published_at,
                w.username AS writer_username,
                w.display_name AS writer_display_name,
                w.avatar_blossom_url AS writer_avatar,
                w.nostr_pubkey AS writer_pubkey
         FROM articles a
         JOIN accounts w ON w.id = a.writer_id
         WHERE a.nostr_d_tag = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL`,
        [dTag]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      const r = rows[0]

      return reply.status(200).send({
        id: r.id,
        nostrEventId: r.nostr_event_id,
        dTag: r.nostr_d_tag,
        title: r.title,
        slug: r.slug,
        summary: r.summary,
        wordCount: r.word_count,
        isPaywalled: r.is_paywalled,
        pricePence: r.price_pence,
        gatePositionPct: r.gate_position_pct,
        vaultEventId: r.vault_event_id,
        publishedAt: r.published_at?.toISOString() ?? null,
        writer: {
          id: r.writer_id,
          username: r.writer_username,
          displayName: r.writer_display_name,
          avatar: r.writer_avatar,
          pubkey: r.writer_pubkey,
        },
      })
    }
  )

  // ---------------------------------------------------------------------------
  // Proxy: POST /articles/:nostrEventId/vault → key service
  // Proxy: PATCH /articles/:nostrEventId/vault → key service
  // Proxy: POST /articles/:nostrEventId/key → key service
  //
  // The gateway adds auth headers and forwards to the key service.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/vault',
    { preHandler: requireAuth },
    async (req, reply) => {
      // Inject writer identity so the key service can verify ownership
      req.headers['x-writer-id'] = req.session!.sub!
      return proxyToService(
        `${KEY_SERVICE_URL}/api/v1/articles/${req.params.nostrEventId}/vault`,
        'POST',
        req,
        reply
      )
    }
  )

  app.patch<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/vault',
    { preHandler: requireAuth },
    async (req, reply) => {
      // Inject writer identity so the key service can verify ownership
      req.headers['x-writer-id'] = req.session!.sub!
      return proxyToService(
        `${KEY_SERVICE_URL}/api/v1/articles/${req.params.nostrEventId}/vault`,
        'PATCH',
        req,
        reply
      )
    }
  )

  app.post<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/key',
    { preHandler: requireAuth },
    async (req, reply) => {
      return proxyToService(
        `${KEY_SERVICE_URL}/api/v1/articles/${req.params.nostrEventId}/key`,
        'POST',
        req,
        reply
      )
    }
  )

  // ---------------------------------------------------------------------------
  // POST /articles/:nostrEventId/gate-pass
  //
  // The full gate-pass flow. Called by the web client when a reader passes
  // a paywall gate. Orchestrates:
  //   1. Look up article + reader tab info
  //   2. Call payment service /gate-pass to record the read
  //   3. If successful, call key service to issue the content key
  //   4. Return the encrypted key to the client
  //
  // This is the single call the web client makes on gate pass — it doesn't
  // need to know about the internal service split.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/gate-pass',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const readerPubkey = req.session!.pubkey
      const { nostrEventId } = req.params

      try {
        // Step 1: Look up article and reader tab
        const articleRow = await pool.query<{
          id: string
          writer_id: string
          price_pence: number
          is_paywalled: boolean
        }>(
          `SELECT id, writer_id, price_pence, is_paywalled
           FROM articles WHERE nostr_event_id = $1`,
          [nostrEventId]
        )

        if (articleRow.rows.length === 0) {
          return reply.status(404).send({ error: 'Article not found' })
        }

        const article = articleRow.rows[0]
        if (!article.is_paywalled) {
          return reply.status(400).send({ error: 'Article is not paywalled' })
        }

        // Check for free access (own content, permanent unlock, subscription)
        const access = await checkArticleAccess(readerId, article.id, article.writer_id)
        if (access.hasAccess) {
          // If subscription read, record the zero-cost read + permanent unlock
          if (access.reason === 'subscription' && access.subscriptionId) {
            await recordSubscriptionRead(readerId, article.id, article.writer_id, access.subscriptionId)
          }

          // Issue content key without charging
          const keyRes = await fetch(
            `${KEY_SERVICE_URL}/api/v1/articles/${nostrEventId}/key`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-reader-id': readerId,
                'x-reader-pubkey': readerPubkey,
              },
              body: JSON.stringify({}),
            }
          )

          if (!keyRes.ok) {
            return reply.status(502).send({ error: 'Key issuance failed' })
          }

          const keyResult = await keyRes.json()
          return reply.status(200).send({
            readEventId: null,
            readState: access.reason,
            encryptedKey: keyResult.encryptedKey,
            algorithm: keyResult.algorithm,
            isReissuance: access.reason === 'already_unlocked',
          })
        }

        // Get reader's tab
        const tabRow = await pool.query<{ id: string }>(
          'SELECT id FROM reading_tabs WHERE reader_id = $1',
          [readerId]
        )

        if (tabRow.rows.length === 0) {
          return reply.status(400).send({ error: 'No reading tab found' })
        }

        const tabId = tabRow.rows[0].id

        // Compute reader pubkey hash (keyed HMAC for privacy)
        const { createHmac } = await import('crypto')
        const hmacKey = process.env.READER_HASH_KEY ?? 'platform-pub-reader-hash-key'
        const readerPubkeyHash = createHmac('sha256', hmacKey)
          .update(readerPubkey)
          .digest('hex')

        // Step 2: Record gate pass via payment service
        const paymentRes = await fetch(`${PAYMENT_SERVICE_URL}/api/v1/gate-pass`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            readerId,
            articleId: article.id,
            writerId: article.writer_id,
            amountPence: article.price_pence,
            readerPubkeyHash,
            tabId,
          }),
        })

        if (!paymentRes.ok) {
          const body = await paymentRes.json().catch(() => null)
          const status = paymentRes.status

          if (status === 402) {
            return reply.status(402).send({
              error: body?.error ?? 'payment_required',
              message: 'Free allowance exhausted — add a payment method.',
            })
          }

          logger.error({ status, body }, 'Payment service gate-pass failed')
          return reply.status(500).send({ error: 'Gate pass recording failed' })
        }

        const paymentResult = await paymentRes.json()

        // Step 3: Request content key from key service
        const keyRes = await fetch(
          `${KEY_SERVICE_URL}/api/v1/articles/${nostrEventId}/key`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-reader-id': readerId,
              'x-reader-pubkey': readerPubkey,
            },
            body: JSON.stringify({}),
          }
        )

        if (!keyRes.ok) {
          const keyBody = await keyRes.json().catch(() => null)
          logger.error(
            { status: keyRes.status, body: keyBody, readerId, nostrEventId },
            'Key service issuance failed after gate pass'
          )
          // The gate pass succeeded — the read is recorded and will be charged.
          // Key issuance failed — this is a retriable error.
          return reply.status(502).send({
            error: 'Key issuance failed — the read has been recorded. Retry to get the content key.',
            readEventId: paymentResult.readEventId,
          })
        }

        const keyResult = await keyRes.json()

        // Record permanent unlock for this purchase
        await recordPurchaseUnlock(readerId, article.id)

        logger.info(
          { readerId, nostrEventId, readEventId: paymentResult.readEventId },
          'Gate pass complete — key issued'
        )

        return reply.status(200).send({
          readEventId: paymentResult.readEventId,
          readState: paymentResult.state,
          encryptedKey: keyResult.encryptedKey,
          algorithm: keyResult.algorithm,
          isReissuance: keyResult.isReissuance,
          allowanceJustExhausted: paymentResult.allowanceJustExhausted ?? false,
        })
      } catch (err) {
        logger.error({ err, readerId, nostrEventId }, 'Gate pass orchestration failed')
        return reply.status(500).send({ error: 'Internal error' })
      }
    }
  )

  // ---------------------------------------------------------------------------
  // Proxy: GET /earnings/:writerId → payment service
  // ---------------------------------------------------------------------------

  app.get<{ Params: { writerId: string } }>(
    '/earnings/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      // Ensure writers can only see their own earnings
      if (req.params.writerId !== req.session!.sub!) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      return proxyToService(
        `${PAYMENT_SERVICE_URL}/api/v1/earnings/${req.params.writerId}`,
        'GET',
        req,
        reply
      )
    }
  )

  // ---------------------------------------------------------------------------
  // Proxy: GET /earnings/:writerId/articles → payment service
  // Per-article earnings breakdown for the dashboard
  // ---------------------------------------------------------------------------

  app.get<{ Params: { writerId: string } }>(
    '/earnings/:writerId/articles',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (req.params.writerId !== req.session!.sub!) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      return proxyToService(
        `${PAYMENT_SERVICE_URL}/api/v1/earnings/${req.params.writerId}/articles`,
        'GET',
        req,
        reply
      )
    }
  )

  // ---------------------------------------------------------------------------
  // GET /my/articles — list the authenticated writer's articles
  //
  // Returns articles joined with comment counts and earnings data.
  // Used by the editorial dashboard.
  // ---------------------------------------------------------------------------

  app.get('/my/articles', { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub!

    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.title, a.slug, a.nostr_d_tag AS d_tag,
                a.nostr_event_id, a.is_paywalled, a.price_pence,
                a.word_count, a.published_at, a.comments_enabled,
                COALESCE(c.cnt, 0)::int AS comment_count,
                COALESCE(r.read_count, 0)::int AS read_count,
                COALESCE(r.net_earnings, 0)::int AS net_earnings_pence
         FROM articles a
         LEFT JOIN (
           SELECT target_event_id, COUNT(*) AS cnt
           FROM comments WHERE deleted_at IS NULL
           GROUP BY target_event_id
         ) c ON c.target_event_id = a.nostr_event_id
         LEFT JOIN (
           SELECT article_id, COUNT(*) AS read_count,
                  SUM(amount_pence) AS net_earnings
           FROM read_events
           WHERE state IN ('platform_settled', 'writer_paid')
           GROUP BY article_id
         ) r ON r.article_id = a.id
         WHERE a.writer_id = $1 AND a.deleted_at IS NULL
         ORDER BY a.published_at DESC`,
        [writerId]
      )

      return reply.status(200).send({
        articles: rows.map(r => ({
          id: r.id,
          title: r.title,
          slug: r.slug,
          dTag: r.d_tag,
          nostrEventId: r.nostr_event_id,
          isPaywalled: r.is_paywalled,
          pricePence: r.price_pence,
          wordCount: r.word_count,
          publishedAt: r.published_at?.toISOString() ?? null,
          commentsEnabled: r.comments_enabled,
          commentCount: r.comment_count,
          readCount: r.read_count,
          netEarningsPence: r.net_earnings_pence,
        })),
      })
    } catch (err) {
      logger.error({ err, writerId }, 'Failed to load writer articles')
      return reply.status(500).send({ error: 'Failed to load articles' })
    }
  })

  // ---------------------------------------------------------------------------
  // PATCH /articles/:id — update article metadata
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/articles/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!
      const body = req.body as Record<string, any>

      const updates: string[] = []
      const params: any[] = []
      let paramIdx = 1

      if (typeof body.commentsEnabled === 'boolean') {
        updates.push(`comments_enabled = $${paramIdx++}`)
        params.push(body.commentsEnabled)
      }

      if (updates.length === 0) {
        return reply.status(400).send({ error: 'No valid fields to update' })
      }

      params.push(req.params.id, writerId)
      const result = await pool.query(
        `UPDATE articles SET ${updates.join(', ')}, updated_at = now()
         WHERE id = $${paramIdx++} AND writer_id = $${paramIdx} AND deleted_at IS NULL
         RETURNING id`,
        params
      )

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /articles/:id — soft-delete an article
  //
  // Sets deleted_at on the articles row. Also publishes a Nostr kind 5
  // deletion event to signal to the relay and federated clients.
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    '/articles/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!

      const { rows } = await pool.query<{ id: string; nostr_event_id: string; nostr_d_tag: string; nostr_pubkey: string }>(
        `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, acc.nostr_pubkey
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE a.id = $1 AND a.writer_id = $2 AND a.deleted_at IS NULL`,
        [req.params.id, writerId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      const article = rows[0]

      // Soft delete
      await pool.query(
        'UPDATE articles SET deleted_at = now() WHERE id = $1',
        [article.id]
      )

      logger.info(
        { articleId: article.id, nostrEventId: article.nostr_event_id, writerId },
        'Article soft-deleted'
      )

      // Publish kind 5 deletion event to the relay so the feed filters it out
      try {
        const deletionEvent = await signEvent(writerId, {
          kind: 5,
          content: '',
          tags: [
            ['e', article.nostr_event_id],
            ['a', `30023:${article.nostr_pubkey}:${article.nostr_d_tag}`],
          ],
          created_at: Math.floor(Date.now() / 1000),
        })
        await publishToRelay(deletionEvent)
        logger.info({ articleId: article.id, deletionEventId: deletionEvent.id }, 'Kind 5 deletion event published')
      } catch (err) {
        // Non-fatal: DB is source of truth; feed will still exclude via deleted_at
        logger.error({ err, articleId: article.id }, 'Failed to publish kind 5 deletion event')
      }

      return reply.status(200).send({
        ok: true,
        deletedArticleId: article.id,
        nostrEventId: article.nostr_event_id,
        dTag: article.nostr_d_tag,
      })
    }
  )
}

// =============================================================================
// Relay publisher — sends a signed Nostr event to the platform strfry relay
// =============================================================================

async function publishToRelay(event: object): Promise<void> {
  const relayUrl = process.env.PLATFORM_RELAY_WS_URL
  if (!relayUrl) throw new Error('PLATFORM_RELAY_WS_URL not set')

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl)
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Relay publish timeout')) }, 5_000)

    ws.onopen = () => { ws.send(JSON.stringify(['EVENT', event])) }

    ws.onmessage = (msg) => {
      try {
        const [type, , success, message] = JSON.parse(msg.data as string)
        if (type === 'OK') {
          clearTimeout(timeout)
          ws.close()
          success ? resolve() : reject(new Error(`Relay rejected event: ${message}`))
        }
      } catch { /* ignore NOTICE etc */ }
    }

    ws.onerror = (err) => { clearTimeout(timeout); reject(err) }
  })
}

// =============================================================================
// Generic service proxy helper
// =============================================================================

async function proxyToService(
  url: string,
  method: string,
  req: any,
  reply: any
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Forward auth headers
    if (req.headers['x-reader-id']) headers['x-reader-id'] = req.headers['x-reader-id'] as string
    if (req.headers['x-reader-pubkey']) headers['x-reader-pubkey'] = req.headers['x-reader-pubkey'] as string
    if (req.headers['x-writer-id']) headers['x-writer-id'] = req.headers['x-writer-id'] as string

    const fetchOpts: RequestInit = { method, headers }
    if (method !== 'GET' && method !== 'HEAD' && req.body) {
      fetchOpts.body = JSON.stringify(req.body)
    }

    const res = await fetch(url, fetchOpts)
    const body = await res.json().catch(() => null)

    return reply.status(res.status).send(body)
  } catch (err) {
    logger.error({ err, url, method }, 'Service proxy failed')
    return reply.status(502).send({ error: 'Upstream service error' })
  }
}
