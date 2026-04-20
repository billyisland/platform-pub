import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createHmac } from 'crypto'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import { checkArticleAccess, recordSubscriptionRead, recordPurchaseUnlock } from '../services/access.js'
import { signEvent } from '../lib/key-custody-client.js'
import { publishToRelay } from '../lib/nostr-publisher.js'
import { checkAndTriggerDriveFulfilment } from './drives.js'
import { sendPublishNotifications } from '../../shared/src/lib/publish-emails.js'
import logger from '../../shared/src/lib/logger.js'
import { requireEnv } from '../../shared/src/lib/env.js'
import { slugify } from '../../shared/src/lib/slug.js'

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

const KEY_SERVICE_URL = requireEnv('KEY_SERVICE_URL')
const PAYMENT_SERVICE_URL = requireEnv('PAYMENT_SERVICE_URL')
const READER_HASH_KEY = requireEnv('READER_HASH_KEY')
const INTERNAL_SERVICE_TOKEN = requireEnv('INTERNAL_SERVICE_TOKEN')

const IndexArticleSchema = z.object({
  nostrEventId: z.string().min(1),
  dTag: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  content: z.string(),                // free section content
  accessMode: z.enum(['public', 'paywalled', 'invitation_only']).default('public'),
  pricePence: z.number().int().min(0).max(999999),
  gatePositionPct: z.number().int().min(0).max(99),
  vaultEventId: z.string().optional(),
  draftId: z.string().optional(),
  sendEmail: z.boolean().optional(),  // writer opt-in/out for publish notification email
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

    const slug = slugify(data.title, 120)

    // Count words
    const wordCount = data.content.split(/\s+/).filter(Boolean).length

    try {
      const isGated = data.accessMode === 'paywalled'

      const { articleId, isNew } = await withTransaction(async (client) => {
        const result = await client.query<{ id: string; is_new: boolean }>(
          `INSERT INTO articles (
             writer_id, nostr_event_id, nostr_d_tag, title, slug, summary,
             content_free, word_count, tier,
             access_mode, price_pence, gate_position_pct, vault_event_id,
             published_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'tier1', $9, $10, $11, $12, now())
           ON CONFLICT (writer_id, nostr_d_tag) WHERE deleted_at IS NULL DO UPDATE SET
             nostr_event_id = EXCLUDED.nostr_event_id,
             title = EXCLUDED.title,
             slug = EXCLUDED.slug,
             summary = EXCLUDED.summary,
             content_free = EXCLUDED.content_free,
             word_count = EXCLUDED.word_count,
             access_mode = EXCLUDED.access_mode,
             price_pence = EXCLUDED.price_pence,
             gate_position_pct = EXCLUDED.gate_position_pct,
             vault_event_id = EXCLUDED.vault_event_id,
             updated_at = now()
           RETURNING id, (xmax = 0) AS is_new`,
          [
            writerId,
            data.nostrEventId,
            data.dTag,
            data.title,
            slug,
            data.summary ?? null,
            data.content,
            wordCount,
            data.accessMode,
            isGated ? data.pricePence : null,
            isGated ? data.gatePositionPct : null,
            data.vaultEventId ?? null,
          ]
        )

        const artId = result.rows[0].id

        // Dual-write: upsert feed_items row in same transaction
        const { rows: [author] } = await client.query<{ display_name: string | null; avatar_blossom_url: string | null; username: string | null }>(
          `SELECT display_name, avatar_blossom_url, username FROM accounts WHERE id = $1`,
          [writerId]
        )
        await client.query(`
          INSERT INTO feed_items (
            item_type, article_id, author_id,
            author_name, author_avatar, author_username,
            title, content_preview, nostr_event_id,
            tier, published_at
          ) VALUES (
            'article', $1, $2,
            $3, $4, $5,
            $6, $7, $8,
            'tier1', now()
          )
          ON CONFLICT (article_id) WHERE article_id IS NOT NULL DO UPDATE SET
            title = EXCLUDED.title,
            content_preview = EXCLUDED.content_preview,
            nostr_event_id = EXCLUDED.nostr_event_id,
            author_name = EXCLUDED.author_name,
            author_avatar = EXCLUDED.author_avatar
        `, [
          artId, writerId,
          author?.display_name ?? author?.username ?? 'Unknown',
          author?.avatar_blossom_url ?? null,
          author?.username ?? null,
          data.title,
          data.content.slice(0, 200),
          data.nostrEventId,
        ])

        return { articleId: artId, isNew: result.rows[0].is_new }
      })

      logger.info(
        { articleId, writerId, nostrEventId: data.nostrEventId, isNew },
        'Article indexed'
      )

      // Check if this article is linked to a pledge drive and trigger fulfilment
      checkAndTriggerDriveFulfilment(writerId, articleId, data.draftId ?? null).catch(err => {
        logger.error({ err, articleId, writerId }, 'Drive fulfilment trigger failed')
      })

      // Notify subscribers via email on first publish (not on edits)
      if (isNew && data.sendEmail !== false) {
        sendPublishNotifications(writerId, articleId, data.title, data.dTag, data.summary, data.content).catch(err => {
          logger.error({ err, articleId, writerId }, 'Publish notification emails failed')
        })
      }

      return reply.status(201).send({ articleId })
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
        content_free: string | null
        word_count: number | null
        access_mode: string
        price_pence: number | null
        gate_position_pct: number | null
        vault_event_id: string | null
        published_at: Date | null
        writer_username: string
        writer_display_name: string | null
        writer_avatar: string | null
        writer_pubkey: string
        writer_subscription_price_pence: number
        publication_id: string | null
        publication_slug: string | null
        publication_name: string | null
        publication_subscription_price_pence: number | null
      }>(
        `SELECT a.id, a.writer_id, a.nostr_event_id, a.nostr_d_tag,
                a.title, a.slug, a.summary, a.content_free, a.word_count,
                a.access_mode, a.price_pence, a.gate_position_pct,
                a.vault_event_id, a.published_at,
                w.username AS writer_username,
                w.display_name AS writer_display_name,
                w.avatar_blossom_url AS writer_avatar,
                w.nostr_pubkey AS writer_pubkey,
                w.subscription_price_pence AS writer_subscription_price_pence,
                a.publication_id,
                p.slug AS publication_slug,
                p.name AS publication_name,
                p.subscription_price_pence AS publication_subscription_price_pence
         FROM articles a
         JOIN accounts w ON w.id = a.writer_id
         LEFT JOIN publications p ON p.id = a.publication_id
         WHERE a.nostr_d_tag = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL`,
        [dTag]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      const r = rows[0]

      // If authenticated reader viewing a paywalled article, include their
      // monthly spend on this writer (for the subscription nudge)
      let writerSpendThisMonthPence: number | null = null
      let nudgeShownThisMonth = false
      const readerId = req.session?.sub
      if (readerId && r.access_mode === 'paywalled' && readerId !== r.writer_id) {
        const spendResult = await pool.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount_pence), 0) AS total
           FROM read_events
           WHERE reader_id = $1 AND writer_id = $2
             AND read_at >= date_trunc('month', now())`,
          [readerId, r.writer_id]
        )
        writerSpendThisMonthPence = parseInt(spendResult.rows[0].total, 10)

        const nudgeResult = await pool.query<{ reader_id: string }>(
          `SELECT reader_id FROM subscription_nudge_log
           WHERE reader_id = $1 AND writer_id = $2 AND month = date_trunc('month', now())::date`,
          [readerId, r.writer_id]
        )
        nudgeShownThisMonth = nudgeResult.rows.length > 0
      }

      return reply.status(200).send({
        id: r.id,
        nostrEventId: r.nostr_event_id,
        dTag: r.nostr_d_tag,
        title: r.title,
        slug: r.slug,
        summary: r.summary,
        contentFree: r.content_free,
        wordCount: r.word_count,
        accessMode: r.access_mode,
        isPaywalled: r.access_mode === 'paywalled',
        pricePence: r.price_pence,
        gatePositionPct: r.gate_position_pct,
        vaultEventId: r.vault_event_id,
        publishedAt: r.published_at?.toISOString() ?? null,
        writerSpendThisMonthPence,
        nudgeShownThisMonth,
        writer: {
          id: r.writer_id,
          username: r.writer_username,
          displayName: r.writer_display_name,
          avatar: r.writer_avatar,
          pubkey: r.writer_pubkey,
          subscriptionPricePence: r.writer_subscription_price_pence,
        },
        publication: r.publication_id ? {
          id: r.publication_id,
          slug: r.publication_slug,
          name: r.publication_name,
          subscriptionPricePence: r.publication_subscription_price_pence,
        } : null,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /articles/by-event/:nostrEventId — fetch article by Nostr event ID
  //
  // Used by the editor to load an article for editing when only the event ID
  // is known. Returns the same shape as GET /articles/:dTag.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { nostrEventId: string } }>(
    '/articles/by-event/:nostrEventId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { nostrEventId } = req.params

      const { rows } = await pool.query(
        `SELECT a.id, a.writer_id, a.nostr_event_id, a.nostr_d_tag,
                a.title, a.slug, a.summary, a.content_free, a.word_count,
                a.access_mode, a.price_pence, a.gate_position_pct,
                a.vault_event_id, a.published_at
         FROM articles a
         WHERE a.nostr_event_id = $1 AND a.deleted_at IS NULL`,
        [nostrEventId]
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
        contentFree: r.content_free,
        wordCount: r.word_count,
        accessMode: r.access_mode,
        isPaywalled: r.access_mode === 'paywalled',
        pricePence: r.price_pence,
        gatePositionPct: r.gate_position_pct,
        publishedAt: r.published_at?.toISOString() ?? null,
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
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
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
          access_mode: string
          publication_id: string | null
        }>(
          `SELECT id, writer_id, price_pence, access_mode, publication_id
           FROM articles WHERE nostr_event_id = $1`,
          [nostrEventId]
        )

        if (articleRow.rows.length === 0) {
          return reply.status(404).send({ error: 'Article not found' })
        }

        const article = articleRow.rows[0]
        if (article.access_mode === 'public') {
          return reply.status(400).send({ error: 'Article is not gated' })
        }

        // Check for free access (own content, permanent unlock, subscription)
        const access = await checkArticleAccess(readerId, article.id, article.writer_id, article.publication_id)
        if (access.hasAccess) {
          // If subscription read, record the zero-cost read + permanent unlock
          if (access.reason === 'subscription' && access.subscriptionId) {
            await recordSubscriptionRead(readerId, article.id, article.writer_id, access.subscriptionId)
          }

          // Issue content key without charging (idempotent — covers retry after
          // a previous gate-pass that charged but crashed before unlock was recorded)
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

          const keyResult = await keyRes.json() as any
          return reply.status(200).send({
            readEventId: null,
            readState: access.reason,
            encryptedKey: keyResult.encryptedKey,
            algorithm: keyResult.algorithm,
            isReissuance: access.reason === 'already_unlocked',
            ciphertext: keyResult.ciphertext ?? undefined,
          })
        }

        // Invitation-only articles cannot be purchased — access is by author grant only
        if (article.access_mode === 'invitation_only') {
          return reply.status(403).send({
            error: 'invitation_required',
            message: 'This is a private article. Contact the author to request access.',
          })
        }

        // Get or create reader's tab
        let tabRow = await pool.query<{ id: string }>(
          'SELECT id FROM reading_tabs WHERE reader_id = $1',
          [readerId]
        )

        if (tabRow.rows.length === 0) {
          tabRow = await pool.query<{ id: string }>(
            `INSERT INTO reading_tabs (reader_id)
             VALUES ($1)
             ON CONFLICT (reader_id) DO NOTHING
             RETURNING id`,
            [readerId]
          )
          if (tabRow.rows.length === 0) {
            tabRow = await pool.query<{ id: string }>(
              'SELECT id FROM reading_tabs WHERE reader_id = $1',
              [readerId]
            )
          }
        }

        const tabId = tabRow.rows[0].id

        // Compute reader pubkey hash (keyed HMAC for privacy)
        if (!READER_HASH_KEY) {
          logger.error('READER_HASH_KEY not set — cannot compute reader pubkey hash')
          return reply.status(500).send({ error: 'Server misconfiguration: READER_HASH_KEY not set' })
        }
        const readerPubkeyHash = createHmac('sha256', READER_HASH_KEY)
          .update(readerPubkey)
          .digest('hex')

        // Step 2: Record gate pass via payment service
        const paymentRes = await fetch(`${PAYMENT_SERVICE_URL}/api/v1/gate-pass`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-token': INTERNAL_SERVICE_TOKEN,
          },
          body: JSON.stringify({
            readerId,
            articleId: article.id,
            writerId: article.writer_id,
            amountPence: article.price_pence,
            readerPubkey,
            readerPubkeyHash,
            tabId,
          }),
        })

        if (!paymentRes.ok) {
          const body = await paymentRes.json().catch(() => null) as any
          const status = paymentRes.status

          if (status === 402) {
            return reply.status(402).send({
              error: body?.error ?? 'payment_required',
              message: 'Payment required.',
            })
          }

          logger.error({ status, body }, 'Payment service gate-pass failed')
          return reply.status(500).send({ error: 'Gate pass recording failed' })
        }

        const paymentResult = await paymentRes.json() as any

        // Record permanent unlock immediately after payment succeeds.
        // This ensures a retry (if key issuance fails below) hits
        // checkArticleAccess → 'already_unlocked' and skips re-charging.
        await recordPurchaseUnlock(readerId, article.id)

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
          // Payment recorded and unlock persisted — retry will skip payment
          // and go straight to key issuance via the 'already_unlocked' path.
          return reply.status(502).send({
            error: 'Key issuance failed — the read has been recorded. Retry to get the content key.',
            readEventId: paymentResult.readEventId,
          })
        }

        const keyResult = await keyRes.json() as any

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
          ciphertext: keyResult.ciphertext ?? undefined,
        })
      } catch (err: any) {
        logger.error({ err, readerId, nostrEventId }, 'Gate pass orchestration failed')
        // Distinguish service-connectivity errors from other failures
        const isNetworkError = err?.cause?.code === 'ECONNREFUSED' ||
          err?.cause?.code === 'ENOTFOUND' ||
          err?.code === 'ECONNREFUSED' ||
          err?.message?.includes('fetch failed')
        if (isNetworkError) {
          return reply.status(502).send({ error: 'Payment or key service unreachable' })
        }
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
                a.nostr_event_id, a.access_mode, a.price_pence,
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
          accessMode: r.access_mode,
          isPaywalled: r.access_mode === 'paywalled',
          pricePence: r.price_pence,
          wordCount: r.word_count,
          publishedAt: r.published_at?.toISOString() ?? null,
          repliesEnabled: r.comments_enabled,
          replyCount: r.comment_count,
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

  const PatchArticleSchema = z.object({
    repliesEnabled: z.boolean().optional(),
    commentsEnabled: z.boolean().optional(),
  })

  app.patch<{ Params: { id: string } }>(
    '/articles/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.params.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
        return reply.status(400).send({ error: 'Invalid article ID' })
      }

      const parsed = PatchArticleSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const writerId = req.session!.sub!
      const body = parsed.data

      const updates: string[] = []
      const params: any[] = []
      let paramIdx = 1

      const repliesEnabledValue = body.repliesEnabled ?? body.commentsEnabled
      if (typeof repliesEnabledValue === 'boolean') {
        updates.push(`comments_enabled = $${paramIdx++}`)
        params.push(repliesEnabledValue)
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

      // Soft-delete all live rows for this d-tag (there may be duplicates from
      // previous publishes/edits that pre-date the unique-live-row constraint).
      // Dual-write to feed_items in the same transaction so a crash between
      // the two UPDATEs can't leave a live feed_items row pointing at a
      // deleted article — the daily reconcile cron used to paper over this.
      await withTransaction(async (client) => {
        await client.query(
          'UPDATE articles SET deleted_at = now() WHERE writer_id = $1 AND nostr_d_tag = $2 AND deleted_at IS NULL',
          [writerId, article.nostr_d_tag]
        )
        await client.query(
          `UPDATE feed_items SET deleted_at = now()
           WHERE article_id IN (SELECT id FROM articles WHERE writer_id = $1 AND nostr_d_tag = $2)
             AND deleted_at IS NULL`,
          [writerId, article.nostr_d_tag]
        )
      })

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
        await publishToRelay(deletionEvent as any)
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

  // ---------------------------------------------------------------------------
  // POST /articles/:id/pin — toggle pin on writer's profile
  //
  // Writers can pin articles to the top of their profile's Work tab.
  // Follows the same toggle pattern as POST /drives/:id/pin.
  // ---------------------------------------------------------------------------

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  app.post<{ Params: { id: string } }>(
    '/articles/:id/pin',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.params.id.match(UUID_RE)) {
        return reply.status(400).send({ error: 'Invalid article ID' })
      }

      const writerId = req.session!.sub!

      const result = await pool.query<{ id: string; pinned_on_profile: boolean }>(
        `UPDATE articles SET pinned_on_profile = NOT pinned_on_profile, updated_at = now()
         WHERE id = $1 AND writer_id = $2 AND deleted_at IS NULL
         RETURNING id, pinned_on_profile`,
        [req.params.id, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      return reply.status(200).send({ pinned: result.rows[0].pinned_on_profile })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /articles/:id/unpublish — revert a personal article to draft
  //
  // Sets published_at = NULL so the article disappears from the writer's
  // public profile and the feed, but remains accessible as a draft.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/articles/:id/unpublish',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.params.id.match(UUID_RE)) {
        return reply.status(400).send({ error: 'Invalid article ID' })
      }

      const writerId = req.session!.sub!

      const result = await pool.query<{ id: string }>(
        `UPDATE articles SET published_at = NULL, updated_at = now()
         WHERE id = $1 AND writer_id = $2 AND deleted_at IS NULL AND published_at IS NOT NULL
           AND publication_id IS NULL
         RETURNING id`,
        [req.params.id, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Article not found or already unpublished' })
      }

      // Remove from feed (unpublished articles are drafts, not in the feed)
      await pool.query(
        `DELETE FROM feed_items WHERE article_id = $1`,
        [req.params.id]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /articles/deleted?pubkeys=<hex>,<hex>,…
  //
  // Returns recently deleted article identifiers for the given Nostr pubkeys.
  // Used by the feed to cross-reference the DB's soft-delete state against
  // events returned from the relay, so feed filtering doesn't rely solely on
  // kind 5 events having been successfully published.
  //
  // Looks back 90 days — long enough that any article a follower could
  // reasonably encounter in a paginated feed is covered.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { pubkeys?: string } }>(
    '/articles/deleted',
    { preHandler: requireAuth },
    async (req, reply) => {
      const raw = req.query.pubkeys ?? ''
      const pubkeys = raw.split(',').map(s => s.trim()).filter(Boolean)

      if (pubkeys.length === 0) {
        return reply.status(200).send({ deletedEventIds: [], deletedCoords: [] })
      }

      const { rows } = await pool.query<{
        nostr_event_id: string
        nostr_d_tag: string
        nostr_pubkey: string
      }>(
        `SELECT a.nostr_event_id, a.nostr_d_tag, acc.nostr_pubkey
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE acc.nostr_pubkey = ANY($1)
           AND a.deleted_at IS NOT NULL
           AND a.deleted_at > now() - interval '90 days'`,
        [pubkeys]
      )

      return reply.status(200).send({
        deletedEventIds: rows.map(r => r.nostr_event_id),
        deletedCoords: rows.map(r => `30023:${r.nostr_pubkey}:${r.nostr_d_tag}`),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /nudge/shown — mark subscription nudge as shown for reader/writer/month
  // ---------------------------------------------------------------------------

  app.post<{ Body: { writerId: string } }>(
    '/nudge/shown',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.body as { writerId: string }

      if (!writerId) {
        return reply.status(400).send({ error: 'writerId is required' })
      }

      await pool.query(
        `INSERT INTO subscription_nudge_log (reader_id, writer_id, month)
         VALUES ($1, $2, date_trunc('month', now())::date)
         ON CONFLICT (reader_id, writer_id, month) DO NOTHING`,
        [readerId, writerId]
      )

      return reply.status(204).send()
    }
  )

  // ---------------------------------------------------------------------------
  // POST /subscriptions/:writerId/convert — subscribe via spend conversion
  //
  // Converts the reader's per-article spend on this writer for the current
  // month into a subscription. Credits back the spend to the reader's tab.
  // The subscription period ends at the end of the current calendar month,
  // then renews at full monthly intervals.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { writerId: string } }>(
    '/subscriptions/:writerId/convert',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.params

      if (readerId === writerId) {
        return reply.status(400).send({ error: 'Cannot subscribe to yourself' })
      }

      return withTransaction(async (client) => {
        // Get writer's subscription price
        const writerResult = await client.query<{
          subscription_price_pence: number
          nostr_pubkey: string
        }>(
          `SELECT subscription_price_pence, nostr_pubkey FROM accounts WHERE id = $1 AND status = 'active'`,
          [writerId]
        )
        if (writerResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Writer not found' })
        }

        const subPrice = writerResult.rows[0].subscription_price_pence

        // Check not already subscribed
        const existingSub = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM subscriptions WHERE reader_id = $1 AND writer_id = $2`,
          [readerId, writerId]
        )
        if (existingSub.rows.length > 0 && existingSub.rows[0].status === 'active') {
          return reply.status(409).send({ error: 'Already subscribed' })
        }

        // Calculate current month spend on this writer
        const spendResult = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount_pence), 0) AS total
           FROM read_events
           WHERE reader_id = $1 AND writer_id = $2
             AND read_at >= date_trunc('month', now())`,
          [readerId, writerId]
        )
        const spendPence = parseInt(spendResult.rows[0].total, 10)

        if (spendPence < Math.floor(subPrice * 0.7)) {
          return reply.status(400).send({ error: 'Spend threshold not met for conversion' })
        }

        // Period ends at end of current calendar month
        const now = new Date()
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1) // first of next month

        // Create or reactivate subscription
        let subscriptionId: string
        if (existingSub.rows.length > 0) {
          await client.query(
            `UPDATE subscriptions
             SET status = 'active', auto_renew = TRUE, cancelled_at = NULL,
                 current_period_start = $1, current_period_end = $2,
                 price_pence = $3, subscription_period = 'monthly', updated_at = now()
             WHERE id = $4`,
            [now, periodEnd, subPrice, existingSub.rows[0].id]
          )
          subscriptionId = existingSub.rows[0].id
        } else {
          const subResult = await client.query<{ id: string }>(
            `INSERT INTO subscriptions (reader_id, writer_id, status, price_pence, subscription_period, current_period_start, current_period_end, auto_renew)
             VALUES ($1, $2, 'active', $3, 'monthly', $4, $5, TRUE)
             RETURNING id`,
            [readerId, writerId, subPrice, now, periodEnd]
          )
          subscriptionId = subResult.rows[0].id
        }

        // Credit back the reader's spend to their tab
        if (spendPence > 0) {
          await client.query(
            `UPDATE reading_tabs SET balance_pence = balance_pence - $1, updated_at = now()
             WHERE reader_id = $2 AND status = 'open'`,
            [spendPence, readerId]
          )
        }

        // Log the subscription charge event
        await client.query(
          `INSERT INTO subscription_events (subscription_id, event_type, reader_id, writer_id, amount_pence, description)
           VALUES ($1, 'subscription_charge', $2, $3, $4, 'Subscription via spend conversion (first month)')`,
          [subscriptionId, readerId, writerId, spendPence > subPrice ? 0 : subPrice - spendPence]
        )

        // Mark the nudge as converted
        await client.query(
          `UPDATE subscription_nudge_log SET converted = TRUE
           WHERE reader_id = $1 AND writer_id = $2 AND month = date_trunc('month', now())::date`,
          [readerId, writerId]
        )

        // Send notification (non-blocking)
        pool.query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
           VALUES ($1, $2, 'new_subscriber')
           ON CONFLICT DO NOTHING`,
          [writerId, readerId]
        ).catch((err) => logger.warn({ err }, 'Failed to insert new_subscriber notification'))

        return reply.status(200).send({ subscriptionId, status: 'active', converted: true })
      })
    }
  )
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
