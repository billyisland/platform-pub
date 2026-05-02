import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import { requirePublicationPermission } from '../../middleware/publication-auth.js'
import { signEvent } from '../../lib/key-custody-client.js'
import { enqueueRelayPublish, type SignedNostrEvent } from '@platform-pub/shared/lib/relay-outbox.js'
import { publishToPublication, approveAndPublishArticle } from '../../services/publication-publisher.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Publication CMS — author-facing article management inside a publication
//
// GET    /publications/:id/articles                          — List
// POST   /publications/:id/articles                          — Submit / publish
// PATCH  /publications/:id/articles/:articleId               — Edit metadata
// DELETE /publications/:id/articles/:articleId               — Soft-delete
// POST   /publications/:id/articles/:articleId/publish       — Approve + publish
// POST   /publications/:id/articles/:articleId/unpublish     — Pull article
// =============================================================================

const SubmitArticleSchema = z.object({
  title: z.string().min(1).max(500),
  summary: z.string().max(500).optional(),
  content: z.string().min(1),
  fullContent: z.string().min(1),
  accessMode: z.enum(['public', 'paywalled']).default('public'),
  pricePence: z.number().int().min(0).optional(),
  gatePositionPct: z.number().int().min(1).max(99).optional(),
  showOnWriterProfile: z.boolean().default(true),
  existingDTag: z.string().optional(),
  coverImageUrl: z.string().url().nullable().optional(),
})

const EditArticleSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  summary: z.string().max(500).nullable().optional(),
  pricePence: z.number().int().min(0).optional(),
  showOnWriterProfile: z.boolean().optional(),
  coverImageUrl: z.string().url().nullable().optional(),
})

export async function publicationCmsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /publications/:id/articles — CMS article list
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string; offset?: string } }>(
    '/publications/:id/articles',
    { preHandler: [requireAuth, requirePublicationPermission()] },
    async (req, reply) => {
      const { id } = req.params
      const member = req.publicationMember!
      const status = (req.query as any).status
      const limit = Math.min(parseInt((req.query as any).limit ?? '50', 10), 100)
      const offset = parseInt((req.query as any).offset ?? '0', 10)

      let statusFilter = ''
      const values: any[] = [id]

      // Contributors only see their own articles
      const isContributorOnly = member.role === 'contributor' && !member.can_edit_others
      if (isContributorOnly) {
        values.push(member.account_id)
      }

      if (status) {
        values.push(status)
        statusFilter = `AND a.publication_article_status = $${values.length}`
      }

      const writerFilter = isContributorOnly ? `AND a.writer_id = $2` : ''

      const { rows } = await pool.query(
        `SELECT a.id, a.title, a.slug, a.nostr_d_tag AS d_tag, a.access_mode,
                a.price_pence, a.publication_article_status AS status,
                a.published_at, a.created_at, a.show_on_writer_profile,
                acc.username AS author_username, acc.display_name AS author_display_name
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE a.publication_id = $1 AND a.deleted_at IS NULL
           ${writerFilter} ${statusFilter}
         ORDER BY a.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values
      )

      return reply.send({ articles: rows })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/articles — Submit or publish an article
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/publications/:id/articles',
    { preHandler: [requireAuth, requirePublicationPermission()] },
    async (req, reply) => {
      const parsed = SubmitArticleSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { id } = req.params
      const member = req.publicationMember!
      const userId = req.session!.sub!
      const userPubkey = req.session!.pubkey!

      const result = await publishToPublication({
        publicationId: id,
        authorId: userId,
        authorPubkey: userPubkey,
        canPublish: member.can_publish,
        ...parsed.data,
      })

      return reply.status(201).send(result)
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/articles/:articleId — Edit article metadata
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/articles/:articleId',
    { preHandler: [requireAuth, requirePublicationPermission('can_edit_others')] },
    async (req, reply) => {
      const parsed = EditArticleSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { id, articleId } = req.params
      const data = parsed.data

      const setClauses: string[] = []
      const values: any[] = []
      let idx = 1

      const fields: Record<string, string> = {
        title: 'title', summary: 'summary',
        pricePence: 'price_pence', showOnWriterProfile: 'show_on_writer_profile',
        coverImageUrl: 'cover_image_url',
      }

      for (const [jsKey, dbCol] of Object.entries(fields)) {
        const val = (data as any)[jsKey]
        if (val !== undefined) {
          setClauses.push(`${dbCol} = $${idx}`)
          values.push(val)
          idx++
        }
      }

      if (setClauses.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' })
      }

      values.push(articleId, id)
      await pool.query(
        `UPDATE articles SET ${setClauses.join(', ')}
         WHERE id = $${idx} AND publication_id = $${idx + 1}`,
        values
      )

      // Dual-write title to feed_items — the only CMS-edited field that
      // is denormalised into the feed. summary/price/visibility read via
      // JOIN at query time and don't need mirroring.
      if (data.title !== undefined) {
        await pool.query(
          `UPDATE feed_items SET title = $1 WHERE article_id = $2`,
          [data.title, articleId]
        )
      }

      // Dual-write cover into feed_items.media so the workspace MediaBlock
      // reflects the change without waiting for a re-publish.
      if (data.coverImageUrl !== undefined) {
        const mediaJson = data.coverImageUrl
          ? JSON.stringify([{ type: 'image', url: data.coverImageUrl }])
          : null
        await pool.query(
          `UPDATE feed_items SET media = $1 WHERE article_id = $2`,
          [mediaJson, articleId]
        )
      }

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /publications/:id/articles/:articleId — Soft-delete article
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/articles/:articleId',
    { preHandler: [requireAuth, requirePublicationPermission('can_edit_others')] },
    async (req, reply) => {
      const { id, articleId } = req.params

      const result = await withTransaction(async (client) => {
        const articleResult = await client.query<{
          nostr_event_id: string
          nostr_d_tag: string
          nostr_pubkey: string
        }>(
          `UPDATE articles SET deleted_at = now(), publication_article_status = 'unpublished'
           WHERE id = $1 AND publication_id = $2
           RETURNING nostr_event_id, nostr_d_tag,
             (SELECT nostr_pubkey FROM publications WHERE id = $2) AS nostr_pubkey`,
          [articleId, id]
        )

        if (articleResult.rows.length === 0) return null
        const article = articleResult.rows[0]

        const deletionEvent = await signEvent(id, {
          kind: 5,
          content: '',
          tags: [
            ['e', article.nostr_event_id],
            ['a', `30023:${article.nostr_pubkey}:${article.nostr_d_tag}`],
          ],
          created_at: Math.floor(Date.now() / 1000),
        }, 'publication')

        await enqueueRelayPublish(client, {
          entityType: 'article_deletion',
          entityId: articleId,
          signedEvent: deletionEvent as SignedNostrEvent,
        })

        return { deletionEventId: deletionEvent.id }
      })

      if (!result) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      logger.info({ articleId, deletionEventId: result.deletionEventId }, 'Publication article soft-deleted and kind-5 enqueued')

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/articles/:articleId/publish — Approve + publish
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/articles/:articleId/publish',
    { preHandler: [requireAuth, requirePublicationPermission('can_publish')] },
    async (req, reply) => {
      const { id, articleId } = req.params
      const editorId = req.session!.sub!

      const result = await approveAndPublishArticle(id, articleId, editorId)
      return reply.send(result)
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/articles/:articleId/unpublish — Pull article
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/articles/:articleId/unpublish',
    { preHandler: [requireAuth, requirePublicationPermission('can_publish')] },
    async (req, reply) => {
      const { id, articleId } = req.params

      await pool.query(
        `UPDATE articles SET publication_article_status = 'unpublished', published_at = NULL
         WHERE id = $1 AND publication_id = $2`,
        [articleId, id]
      )

      return reply.send({ ok: true })
    }
  )
}
