import type { FastifyInstance } from 'fastify'
import { pool } from '../../shared/src/db/client.js'
import { optionalAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Writer Routes
//
// GET /writers/:username   — Public writer profile (for /:username page)
// GET /writers/:username/articles — Writer's published articles (DB index)
//
// These are public routes — no auth required. The writer profile page is
// the primary landing surface for cold traffic per ADR §II.5:
//   "The primary cold traffic pattern at launch is writer-directed: a writer
//    posts 'find me at writer.platform.pub' and their audience follows that link."
// =============================================================================

export async function writerRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /writers/:username — public writer profile
  // ---------------------------------------------------------------------------

  app.get<{ Params: { username: string } }>(
    '/writers/:username',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params

      const { rows } = await pool.query<{
        id: string
        nostr_pubkey: string
        username: string
        display_name: string | null
        bio: string | null
        avatar_blossom_url: string | null
        hosting_type: string
        subscription_price_pence: number
      }>(
        `SELECT id, nostr_pubkey, username, display_name, bio,
                avatar_blossom_url, hosting_type, subscription_price_pence
         FROM accounts
         WHERE username = $1 AND status = 'active'`,
        [username]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Writer not found' })
      }

      const writer = rows[0]

      // Count published articles
      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM articles
         WHERE writer_id = $1 AND published_at IS NOT NULL AND deleted_at IS NULL`,
        [writer.id]
      )

      return reply.status(200).send({
        id: writer.id,
        pubkey: writer.nostr_pubkey,
        username: writer.username,
        displayName: writer.display_name,
        bio: writer.bio,
        avatar: writer.avatar_blossom_url,
        hostingType: writer.hosting_type,
        subscriptionPricePence: writer.subscription_price_pence,
        articleCount: parseInt(countResult.rows[0].count, 10),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/:username/articles — writer's published articles
  //
  // Returns article metadata from the platform DB index.
  // The full content is on the relay; this endpoint serves feed/profile data.
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { username: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/writers/:username/articles',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 50)
      const offset = parseInt(req.query.offset ?? '0', 10)

      // Look up writer
      const writerResult = await pool.query<{ id: string }>(
        `SELECT id FROM accounts
         WHERE username = $1 AND status = 'active'`,
        [username]
      )

      if (writerResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Writer not found' })
      }

      const writerId = writerResult.rows[0].id

      const { rows } = await pool.query<{
        id: string
        nostr_event_id: string
        nostr_d_tag: string
        title: string
        slug: string
        summary: string | null
        content_free: string | null
        word_count: number | null
        is_paywalled: boolean
        price_pence: number | null
        gate_position_pct: number | null
        published_at: Date | null
      }>(
        `SELECT id, nostr_event_id, nostr_d_tag, title, slug, summary,
                content_free, word_count, is_paywalled, price_pence,
                gate_position_pct, published_at
         FROM articles
         WHERE writer_id = $1 AND published_at IS NOT NULL AND deleted_at IS NULL
         ORDER BY published_at DESC
         LIMIT $2 OFFSET $3`,
        [writerId, limit, offset]
      )

      const articles = rows.map((r) => ({
        id: r.id,
        nostrEventId: r.nostr_event_id,
        dTag: r.nostr_d_tag,
        title: r.title,
        slug: r.slug,
        summary: r.summary,
        wordCount: r.word_count,
        isPaywalled: r.is_paywalled,
        publishedAt: r.published_at?.toISOString() ?? null,
      }))

      return reply.status(200).send({ articles, limit, offset })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/:username/notes — writer's published notes
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { username: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/writers/:username/notes',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 50)
      const offset = parseInt(req.query.offset ?? '0', 10)

      const accountResult = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE username = $1 AND status = 'active'`,
        [username]
      )

      if (accountResult.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' })
      }

      const authorId = accountResult.rows[0].id

      const { rows } = await pool.query<{
        id: string
        nostr_event_id: string
        content: string
        published_at: Date
      }>(
        `SELECT id, nostr_event_id, content, published_at
         FROM notes
         WHERE author_id = $1 AND deleted_at IS NULL
         ORDER BY published_at DESC
         LIMIT $2 OFFSET $3`,
        [authorId, limit, offset]
      )

      const notes = rows.map((r) => ({
        id: r.id,
        nostrEventId: r.nostr_event_id,
        content: r.content,
        publishedAt: r.published_at.toISOString(),
      }))

      return reply.status(200).send({ notes, limit, offset })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/:username/replies — writer's published replies
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { username: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/writers/:username/replies',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 50)
      const offset = parseInt(req.query.offset ?? '0', 10)

      const accountResult = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE username = $1 AND status = 'active'`,
        [username]
      )

      if (accountResult.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' })
      }

      const authorId = accountResult.rows[0].id

      const { rows } = await pool.query<{
        id: string
        nostr_event_id: string
        content: string
        published_at: Date
      }>(
        `SELECT id, nostr_event_id, content, published_at
         FROM comments
         WHERE author_id = $1 AND deleted_at IS NULL
         ORDER BY published_at DESC
         LIMIT $2 OFFSET $3`,
        [authorId, limit, offset]
      )

      const replies = rows.map((r) => ({
        id: r.id,
        nostrEventId: r.nostr_event_id,
        content: r.content,
        publishedAt: r.published_at.toISOString(),
      }))

      return reply.status(200).send({ replies, limit, offset })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/by-pubkey/:pubkey — resolve pubkey → writer info
  //
  // Used by feed cards to resolve a Nostr pubkey to a display name.
  // The feed fetches articles from the relay (which only has pubkeys),
  // then the client resolves names via this endpoint.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { pubkey: string } }>(
    '/writers/by-pubkey/:pubkey',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { pubkey } = req.params

      if (!pubkey.match(/^[0-9a-f]{64}$/)) {
        return reply.status(400).send({ error: 'Invalid pubkey format' })
      }

      const { rows } = await pool.query<{
        username: string
        display_name: string | null
        avatar_blossom_url: string | null
      }>(
        `SELECT username, display_name, avatar_blossom_url
         FROM accounts
         WHERE nostr_pubkey = $1 AND status = 'active'`,
        [pubkey]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Writer not found' })
      }

      const w = rows[0]
      return reply.status(200).send({
        username: w.username,
        displayName: w.display_name,
        avatar: w.avatar_blossom_url,
      })
    }
  )
}
