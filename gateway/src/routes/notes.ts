import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Note Routes
//
// POST   /notes                    — Index a published note
// DELETE /notes/:nostrEventId      — Delete a note (author only)
// =============================================================================

const NOTE_CHAR_LIMIT = 1000

const IndexNoteSchema = z.object({
  nostrEventId: z.string().min(1),
  content: z.string().min(1).max(NOTE_CHAR_LIMIT),
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
           author_id, nostr_event_id, content, char_count, tier, published_at
         ) VALUES ($1, $2, $3, $4, 'tier1', now())
         ON CONFLICT (nostr_event_id) DO NOTHING
         RETURNING id`,
        [
          authorId,
          data.nostrEventId,
          data.content,
          data.content.length,
        ]
      )

      if (result.rows.length === 0) {
        return reply.status(200).send({ ok: true, duplicate: true })
      }

      logger.info(
        { noteId: result.rows[0].id, authorId, nostrEventId: data.nostrEventId },
        'Note indexed'
      )

      return reply.status(201).send({ noteId: result.rows[0].id })
    } catch (err) {
      logger.error({ err, authorId }, 'Note indexing failed')
      return reply.status(500).send({ error: 'Indexing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // DELETE /notes/:nostrEventId — delete a note
  //
  // Only the note's author can delete it. Removes from the platform DB index.
  // The relay event is not deleted here (that would require a kind 5 deletion
  // event, which the feed code already filters for).
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

        return reply.status(200).send({ ok: true, deletedNostrEventId: nostrEventId })
      } catch (err) {
        logger.error({ err, nostrEventId, authorId }, 'Note deletion failed')
        return reply.status(500).send({ error: 'Deletion failed' })
      }
    }
  )
}
