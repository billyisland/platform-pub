import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { signEvent } from '../lib/key-custody-client.js'
import { publishToRelay } from '../lib/nostr-publisher.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Note Routes
//
// POST   /notes                    — Index a published note
// DELETE /notes/:nostrEventId      — Delete a note (author only)
// GET    /content/resolve          — Resolve an event ID to preview metadata
// GET    /feed/global              — Global "For you" feed (all articles + notes + new users)
// =============================================================================

const NOTE_CHAR_LIMIT = 1000

const IndexNoteSchema = z.object({
  nostrEventId: z.string().min(1),
  content: z.string().min(1).max(NOTE_CHAR_LIMIT),
  isQuoteComment: z.boolean().optional(),
  quotedEventId: z.string().optional(),
  quotedEventKind: z.number().int().optional(),
})

export async function noteRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /notes — index a published note
  // ---------------------------------------------------------------------------

  app.post('/notes', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = IndexNoteSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const authorId = req.session!.sub!
    const data = parsed.data

    try {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO notes (
           author_id, nostr_event_id, content, char_count, tier, published_at,
           is_quote_comment, quoted_event_id, quoted_event_kind
         ) VALUES ($1, $2, $3, $4, 'tier1', now(), $5, $6, $7)
         ON CONFLICT (nostr_event_id) DO NOTHING
         RETURNING id`,
        [
          authorId,
          data.nostrEventId,
          data.content,
          data.content.length,
          data.isQuoteComment ?? false,
          data.quotedEventId ?? null,
          data.quotedEventKind ?? null,
        ]
      )

      if (result.rows.length === 0) {
        return reply.status(200).send({ ok: true, duplicate: true })
      }

      logger.info(
        { noteId: result.rows[0].id, authorId, nostrEventId: data.nostrEventId },
        'Note indexed'
      )

      // Notify quoted content author (fire-and-forget)
      if (data.isQuoteComment && data.quotedEventId) {
        const quotedNote = await pool.query<{ author_id: string }>(
          `SELECT author_id FROM notes WHERE nostr_event_id = $1`,
          [data.quotedEventId]
        )
        const quotedArticle = quotedNote.rows.length === 0
          ? await pool.query<{ author_id: string }>(
              `SELECT writer_id AS author_id FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
              [data.quotedEventId]
            )
          : quotedNote
        const quotedAuthorId = quotedArticle.rows[0]?.author_id
        if (quotedAuthorId && quotedAuthorId !== authorId) {
          pool.query(
            `INSERT INTO notifications (recipient_id, actor_id, type)
             VALUES ($1, $2, 'new_quote')`,
            [quotedAuthorId, authorId]
          ).catch((err) => logger.warn({ err }, 'Failed to insert new_quote notification'))
        }
      }

      // Notify @mentioned users (fire-and-forget)
      const mentionMatches = data.content.matchAll(/@([a-zA-Z0-9_]+)/g)
      const mentionedUsernames = [...new Set([...mentionMatches].map(m => m[1]))]
      if (mentionedUsernames.length > 0) {
        const { rows: mentionedUsers } = await pool.query<{ id: string }>(
          `SELECT id FROM accounts WHERE username = ANY($1) AND status = 'active' AND id != $2`,
          [mentionedUsernames, authorId]
        )
        for (const mentioned of mentionedUsers) {
          pool.query(
            `INSERT INTO notifications (recipient_id, actor_id, type)
             VALUES ($1, $2, 'new_mention')`,
            [mentioned.id, authorId]
          ).catch((err) => logger.warn({ err }, 'Failed to insert mention notification'))
        }
      }

      return reply.status(201).send({ noteId: result.rows[0].id })
    } catch (err) {
      logger.error({ err, authorId }, 'Note indexing failed')
      return reply.status(500).send({ error: 'Indexing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // DELETE /notes/:nostrEventId — delete a note
  //
  // Only the note's author can delete it. Removes from the platform DB index
  // and publishes a kind 5 deletion event to the relay so the note is filtered
  // from Nostr feeds.
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { nostrEventId: string } }>(
    '/notes/:nostrEventId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const authorId = req.session!.sub!
      const { nostrEventId } = req.params

      try {
        const result = await pool.query(
          `DELETE FROM notes
           WHERE nostr_event_id = $1 AND author_id = $2
           RETURNING id`,
          [nostrEventId, authorId]
        )

        if (result.rowCount === 0) {
          return reply.status(404).send({ error: 'Note not found or not yours' })
        }

        logger.info({ nostrEventId, authorId }, 'Note deleted')

        // Publish kind 5 deletion event so the relay filters the note from feeds
        try {
          const deletionEvent = await signEvent(authorId, {
            kind: 5,
            content: '',
            tags: [['e', nostrEventId]],
            created_at: Math.floor(Date.now() / 1000),
          })
          await publishToRelay(deletionEvent as any)
          logger.info({ nostrEventId, deletionEventId: deletionEvent.id }, 'Kind 5 deletion event published for note')
        } catch (err) {
          // Non-fatal: note is removed from DB; feed will stop showing it once
          // strfry's stored event is evicted or the client refreshes past it.
          logger.error({ err, nostrEventId }, 'Failed to publish kind 5 deletion event for note')
        }

        return reply.status(200).send({ ok: true, deletedNostrEventId: nostrEventId })
      } catch (err) {
        logger.error({ err, nostrEventId, authorId }, 'Note deletion failed')
        return reply.status(500).send({ error: 'Deletion failed' })
      }
    }
  )

  // ---------------------------------------------------------------------------
  // GET /content/resolve?eventId=xxx
  //
  // Resolves a Nostr event ID to preview metadata for quote cards.
  // Checks notes first, then articles. Returns author info + content snippet.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { eventId?: string } }>(
    '/content/resolve',
    async (req, reply) => {
      const { eventId } = req.query
      if (!eventId) return reply.status(400).send({ error: 'eventId required' })

      try {
        // Check notes table first
        const noteResult = await pool.query(
          `SELECT n.nostr_event_id, n.content, n.published_at,
                  a.username, a.display_name, a.avatar_blossom_url AS avatar
           FROM notes n
           JOIN accounts a ON a.id = n.author_id
           WHERE n.nostr_event_id = $1`,
          [eventId]
        )

        if (noteResult.rows.length > 0) {
          const row = noteResult.rows[0]
          return reply.send({
            type: 'note',
            eventId: row.nostr_event_id,
            content: row.content.slice(0, 200),
            publishedAt: Math.floor(new Date(row.published_at).getTime() / 1000),
            author: {
              username: row.username,
              displayName: row.display_name,
              avatar: row.avatar,
            },
          })
        }

        // Check articles table
        const articleResult = await pool.query(
          `SELECT ar.nostr_event_id, ar.title, ar.nostr_d_tag, ar.summary,
                  ar.content_free, ar.is_paywalled, ar.published_at,
                  a.username, a.display_name, a.avatar
           FROM articles ar
           JOIN accounts a ON a.id = ar.writer_id
           WHERE ar.nostr_event_id = $1`,
          [eventId]
        )

        if (articleResult.rows.length > 0) {
          const row = articleResult.rows[0]
          const contentSnippet = row.summary
            ? row.summary.slice(0, 200)
            : (row.content_free ?? '').replace(/^#{1,6}\s+.*/gm, '').replace(/!\[.*?\]\(.*?\)/g, '').replace(/\*\*?(.+?)\*\*?/g, '$1').replace(/\n+/g, ' ').trim().slice(0, 200)
          return reply.send({
            type: 'article',
            eventId: row.nostr_event_id,
            title: row.title,
            dTag: row.nostr_d_tag,
            isPaywalled: row.is_paywalled,
            content: contentSnippet,
            publishedAt: Math.floor(new Date(row.published_at).getTime() / 1000),
            author: {
              username: row.username,
              displayName: row.display_name,
              avatar: row.avatar,
            },
          })
        }

        return reply.status(404).send({ error: 'Event not found' })
      } catch (err) {
        logger.error({ err, eventId }, 'Content resolve failed')
        return reply.status(500).send({ error: 'Resolve failed' })
      }
    }
  )

  // ---------------------------------------------------------------------------
  // GET /feed/global — global "For you" feed
  //
  // Returns the most recent articles, notes (non-replies), and new user signups
  // interleaved and sorted by timestamp descending. Used for the "For you" tab.
  // ---------------------------------------------------------------------------

  app.get('/feed/global', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const [articlesRes, notesRes, newUsersRes] = await Promise.all([
        pool.query(`
          SELECT
            a.nostr_event_id, a.nostr_d_tag, a.title, a.summary, a.content_free,
            a.is_paywalled, a.price_pence, a.gate_position_pct,
            EXTRACT(EPOCH FROM a.published_at)::bigint AS published_at,
            acc.nostr_pubkey
          FROM articles a
          JOIN accounts acc ON acc.id = a.writer_id
          WHERE a.deleted_at IS NULL AND a.published_at IS NOT NULL
          ORDER BY a.published_at DESC
          LIMIT 30
        `),
        pool.query(`
          SELECT
            n.nostr_event_id, n.content, n.is_quote_comment,
            n.quoted_event_id, n.quoted_event_kind,
            EXTRACT(EPOCH FROM n.published_at)::bigint AS published_at,
            acc.nostr_pubkey
          FROM notes n
          JOIN accounts acc ON acc.id = n.author_id
          WHERE n.reply_to_event_id IS NULL
          ORDER BY n.published_at DESC
          LIMIT 30
        `),
        pool.query(`
          SELECT username, display_name, avatar_blossom_url,
            EXTRACT(EPOCH FROM created_at)::bigint AS joined_at
          FROM accounts
          WHERE status = 'active'
          ORDER BY created_at DESC
          LIMIT 20
        `),
      ])

      const items: any[] = []

      for (const row of articlesRes.rows) {
        items.push({
          type: 'article',
          nostrEventId: row.nostr_event_id,
          pubkey: row.nostr_pubkey,
          dTag: row.nostr_d_tag,
          title: row.title,
          summary: row.summary ?? '',
          contentFree: row.content_free ?? '',
          isPaywalled: row.is_paywalled,
          pricePence: row.price_pence ?? undefined,
          gatePositionPct: row.gate_position_pct ?? undefined,
          publishedAt: Number(row.published_at),
        })
      }

      for (const row of notesRes.rows) {
        items.push({
          type: 'note',
          nostrEventId: row.nostr_event_id,
          pubkey: row.nostr_pubkey,
          content: row.content,
          isQuoteComment: row.is_quote_comment,
          quotedEventId: row.quoted_event_id ?? undefined,
          quotedEventKind: row.quoted_event_kind ?? undefined,
          publishedAt: Number(row.published_at),
        })
      }

      for (const row of newUsersRes.rows) {
        items.push({
          type: 'new_user',
          username: row.username,
          displayName: row.display_name,
          avatar: row.avatar_blossom_url,
          joinedAt: Number(row.joined_at),
        })
      }

      items.sort((a, b) => {
        const ta = a.type === 'new_user' ? a.joinedAt : a.publishedAt
        const tb = b.type === 'new_user' ? b.joinedAt : b.publishedAt
        return tb - ta
      })

      return reply.send({ items })
    } catch (err) {
      logger.error({ err }, 'Global feed fetch failed')
      return reply.status(500).send({ error: 'Feed fetch failed' })
    }
  })
}
