import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth, optionalAuth } from '../../middleware/auth.js'
import { checkAndTriggerDriveFulfilment } from '../drives.js'
import { sendPublishNotifications } from '@platform-pub/shared/lib/publish-emails.js'
import { slugify } from '@platform-pub/shared/lib/slug.js'
import { truncatePreview } from '@platform-pub/shared/lib/text.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Article publishing + public reads
//
// POST /articles                            — Index a published article in the DB
// GET  /articles/:dTag                      — Fetch article metadata by d-tag
// GET  /articles/by-event/:nostrEventId     — Fetch article by Nostr event ID
// =============================================================================

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
  coverImageUrl: z.string().url().nullable().optional(),
  draftId: z.string().optional(),
  sendEmail: z.boolean().optional(),  // writer opt-in/out for publish notification email
})

export async function articlePublishRoutes(app: FastifyInstance) {
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
             cover_image_url, published_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'tier1', $9, $10, $11, $12, $13, now())
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
             cover_image_url = EXCLUDED.cover_image_url,
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
            data.coverImageUrl ?? null,
          ]
        )

        const artId = result.rows[0].id

        // Dual-write: upsert feed_items row in same transaction
        const { rows: [author] } = await client.query<{ display_name: string | null; avatar_blossom_url: string | null; username: string | null }>(
          `SELECT display_name, avatar_blossom_url, username FROM accounts WHERE id = $1`,
          [writerId]
        )
        const mediaJson = data.coverImageUrl
          ? JSON.stringify([{ type: 'image', url: data.coverImageUrl }])
          : null
        await client.query(`
          INSERT INTO feed_items (
            item_type, article_id, author_id,
            author_name, author_avatar, author_username,
            title, content_preview, nostr_event_id,
            media, tier, published_at
          ) VALUES (
            'article', $1, $2,
            $3, $4, $5,
            $6, $7, $8,
            $9, 'tier1', now()
          )
          ON CONFLICT (article_id) WHERE article_id IS NOT NULL DO UPDATE SET
            title = EXCLUDED.title,
            content_preview = EXCLUDED.content_preview,
            nostr_event_id = EXCLUDED.nostr_event_id,
            author_name = EXCLUDED.author_name,
            author_avatar = EXCLUDED.author_avatar,
            media = EXCLUDED.media
        `, [
          artId, writerId,
          author?.display_name ?? author?.username ?? 'Unknown',
          author?.avatar_blossom_url ?? null,
          author?.username ?? null,
          data.title,
          truncatePreview(data.content),
          data.nostrEventId,
          mediaJson,
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
        cover_image_url: string | null
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
                a.vault_event_id, a.cover_image_url, a.published_at,
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
        coverImageUrl: r.cover_image_url,
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
                a.vault_event_id, a.cover_image_url, a.published_at
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
        coverImageUrl: r.cover_image_url,
        publishedAt: r.published_at?.toISOString() ?? null,
      })
    }
  )
}
