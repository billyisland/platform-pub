import type { FastifyInstance } from 'fastify'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'

// =============================================================================
// Tag Routes
//
// GET  /tags/search?q=<query>          — autocomplete search
// GET  /tags/:name                     — articles by tag
// GET  /articles/:articleId/tags       — tags for an article
// PUT  /articles/:articleId/tags       — set tags for an article (writer only)
// =============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]?$/

export async function tagRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /tags/search?q=<query> — autocomplete with article counts
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { q?: string } }>(
    '/tags/search',
    async (req, reply) => {
      const q = (req.query.q ?? '').toLowerCase().trim()
      if (!q || q.length < 1) {
        return reply.send({ tags: [] })
      }

      const { rows } = await pool.query<{ name: string; count: string }>(
        `SELECT t.name, COUNT(at.article_id)::text AS count
         FROM tags t
         LEFT JOIN article_tags at ON at.tag_id = t.id
         WHERE t.name LIKE $1
         GROUP BY t.id
         ORDER BY COUNT(at.article_id) DESC
         LIMIT 10`,
        [`${q}%`]
      )

      return reply.send({ tags: rows.map(r => ({ name: r.name, count: parseInt(r.count, 10) })) })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /tags/:name — articles with this tag (paginated, newest first)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { name: string }; Querystring: { limit?: string; offset?: string } }>(
    '/tags/:name',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const tagName = req.params.name.toLowerCase()
      const limit = Math.min(parseInt(req.query.limit ?? '20', 10) || 20, 50)
      const offset = parseInt(req.query.offset ?? '0', 10) || 0

      const { rows: tagRows } = await pool.query<{ id: string }>(
        'SELECT id FROM tags WHERE name = $1',
        [tagName]
      )
      if (tagRows.length === 0) {
        return reply.send({ tag: tagName, articles: [], total: 0 })
      }

      const tagId = tagRows[0].id

      const [countRes, articleRes] = await Promise.all([
        pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM article_tags at
           JOIN articles a ON a.id = at.article_id
           WHERE at.tag_id = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL`,
          [tagId]
        ),
        pool.query(
          `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.title, a.slug, a.summary,
                  a.word_count, a.access_mode, a.price_pence, a.published_at,
                  acc.username AS author_username, acc.display_name AS author_display_name,
                  acc.nostr_pubkey AS author_pubkey, acc.avatar_blossom_url AS author_avatar
           FROM article_tags at
           JOIN articles a ON a.id = at.article_id
           JOIN accounts acc ON acc.id = a.writer_id
           WHERE at.tag_id = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL
           ORDER BY a.published_at DESC
           LIMIT $2 OFFSET $3`,
          [tagId, limit, offset]
        ),
      ])

      return reply.send({
        tag: tagName,
        articles: articleRes.rows,
        total: parseInt(countRes.rows[0].total, 10),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /articles/:articleId/tags — tags for a specific article
  // ---------------------------------------------------------------------------

  app.get<{ Params: { articleId: string } }>(
    '/articles/:articleId/tags',
    async (req, reply) => {
      const { articleId } = req.params
      if (!articleId.match(UUID_RE)) {
        return reply.status(400).send({ error: 'Invalid article ID' })
      }

      const { rows } = await pool.query<{ name: string }>(
        `SELECT t.name FROM article_tags at
         JOIN tags t ON t.id = at.tag_id
         WHERE at.article_id = $1
         ORDER BY t.name`,
        [articleId]
      )

      return reply.send({ tags: rows.map(r => r.name) })
    }
  )

  // ---------------------------------------------------------------------------
  // PUT /articles/:articleId/tags — set tags for an article (replaces all)
  //   Body: { tags: string[] }  (max 5, normalised lowercase, hyphens ok)
  // ---------------------------------------------------------------------------

  app.put<{ Params: { articleId: string }; Body: { tags: string[] } }>(
    '/articles/:articleId/tags',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!
      const { articleId } = req.params
      const { tags } = req.body as { tags: string[] }

      if (!articleId.match(UUID_RE)) {
        return reply.status(400).send({ error: 'Invalid article ID' })
      }

      if (!Array.isArray(tags) || tags.length > 5) {
        return reply.status(400).send({ error: 'Maximum 5 tags allowed' })
      }

      const normalised = tags
        .map(t => t.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
        .filter(t => TAG_RE.test(t))
        .slice(0, 5)

      // Verify ownership
      const { rows: artRows } = await pool.query<{ id: string }>(
        'SELECT id FROM articles WHERE id = $1 AND writer_id = $2 AND deleted_at IS NULL',
        [articleId, writerId]
      )
      if (artRows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      await withTransaction(async (client) => {
        // Remove existing tags
        await client.query('DELETE FROM article_tags WHERE article_id = $1', [articleId])

        if (normalised.length > 0) {
          // Upsert tags
          for (const name of normalised) {
            await client.query(
              'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
              [name]
            )
          }

          // Get tag IDs
          const { rows: tagRows } = await client.query<{ id: string; name: string }>(
            'SELECT id, name FROM tags WHERE name = ANY($1)',
            [normalised]
          )

          // Insert article_tags
          for (const tag of tagRows) {
            await client.query(
              'INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [articleId, tag.id]
            )
          }
        }
      })

      return reply.send({ ok: true, tags: normalised })
    }
  )
}
