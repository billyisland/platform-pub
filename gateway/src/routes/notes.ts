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
  quotedExcerpt: z.string().optional(),
  quotedTitle: z.string().optional(),
  quotedAuthor: z.string().optional(),
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
           is_quote_comment, quoted_event_id, quoted_event_kind,
           quoted_excerpt, quoted_title, quoted_author
         ) VALUES ($1, $2, $3, $4, 'tier1', now(), $5, $6, $7, $8, $9, $10)
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
          data.quotedExcerpt ?? null,
          data.quotedTitle ?? null,
          data.quotedAuthor ?? null,
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
          try {
            await pool.query(
              `INSERT INTO notifications (recipient_id, actor_id, type)
               VALUES ($1, $2, 'new_quote')
               ON CONFLICT DO NOTHING`,
              [quotedAuthorId, authorId]
            )
          } catch (err) {
            logger.warn({ err }, 'Failed to insert new_quote notification')
          }
        }
      }

      // Notify @mentioned users (fire-and-forget, batched)
      const mentionMatches = data.content.matchAll(/(?<![a-zA-Z0-9.])@([a-zA-Z0-9_]+)/g)
      const mentionedUsernames = [...new Set([...mentionMatches].map(m => m[1]))]
      if (mentionedUsernames.length > 0) {
        const { rows: mentionedUsers } = await pool.query<{ id: string }>(
          `SELECT id FROM accounts WHERE username = ANY($1) AND status = 'active' AND id != $2`,
          [mentionedUsernames, authorId]
        )
        if (mentionedUsers.length > 0) {
          const values: string[] = []
          const params: string[] = []
          mentionedUsers.forEach((mentioned, i) => {
            values.push(`($${i * 2 + 1}, $${i * 2 + 2}, 'new_mention')`)
            params.push(mentioned.id, authorId)
          })
          try {
            await pool.query(
              `INSERT INTO notifications (recipient_id, actor_id, type)
               VALUES ${values.join(', ')}
               ON CONFLICT DO NOTHING`,
              params
            )
          } catch (err) {
            logger.warn({ err }, 'Failed to insert mention notifications')
          }
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
            content: row.content,
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
                  ar.content_free, ar.access_mode, ar.published_at,
                  a.username, a.display_name, a.avatar_blossom_url AS avatar
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
            accessMode: row.access_mode,
            isPaywalled: row.access_mode === 'paywalled',
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
}
