import type { FastifyInstance } from 'fastify'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Notification Routes
//
// GET  /notifications          — list recent notifications for current user
// POST /notifications/read-all — mark all notifications as read
// =============================================================================

export async function notificationRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /notifications — list recent notifications (newest first, max 50)
  // ---------------------------------------------------------------------------

  app.get('/notifications', { preHandler: requireAuth }, async (req, reply) => {
    const recipientId = req.session!.sub!

    const { rows } = await pool.query<{
      id: string
      type: string
      read: boolean
      created_at: Date
      actor_id: string | null
      actor_username: string | null
      actor_display_name: string | null
      actor_avatar: string | null
      article_id: string | null
      article_title: string | null
      article_slug: string | null
      article_writer_username: string | null
      comment_id: string | null
      comment_content: string | null
      note_id: string | null
      note_nostr_event_id: string | null
      conversation_id: string | null
      drive_id: string | null
    }>(
      `SELECT
         n.id, n.type, n.read, n.created_at,
         n.actor_id,
         a.username           AS actor_username,
         a.display_name       AS actor_display_name,
         a.avatar_blossom_url AS actor_avatar,
         n.article_id,
         ar.title             AS article_title,
         ar.nostr_d_tag       AS article_slug,
         aw.username          AS article_writer_username,
         n.comment_id,
         LEFT(c.content, 200) AS comment_content,
         n.note_id,
         no.nostr_event_id    AS note_nostr_event_id,
         n.conversation_id,
         n.drive_id
       FROM notifications n
       LEFT JOIN accounts a   ON a.id   = n.actor_id
       LEFT JOIN articles ar  ON ar.id  = n.article_id
       LEFT JOIN accounts aw  ON aw.id  = ar.writer_id
       LEFT JOIN comments c   ON c.id   = n.comment_id
       LEFT JOIN notes no     ON no.id  = n.note_id
       WHERE n.recipient_id = $1 AND n.read = false
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [recipientId]
    )

    const unreadCount = rows.length

    const notifications = rows.map((r) => ({
      id: r.id,
      type: r.type,
      read: r.read,
      createdAt: r.created_at.toISOString(),
      actor: r.actor_id
        ? {
            id: r.actor_id,
            username: r.actor_username,
            displayName: r.actor_display_name,
            avatar: r.actor_avatar,
          }
        : null,
      article: r.article_id
        ? { id: r.article_id, title: r.article_title, slug: r.article_slug, writerUsername: r.article_writer_username }
        : null,
      comment: r.comment_id
        ? { id: r.comment_id, content: r.comment_content }
        : null,
      note: r.note_id
        ? { id: r.note_id, nostrEventId: r.note_nostr_event_id }
        : null,
      conversationId: r.conversation_id ?? undefined,
      driveId: r.drive_id ?? undefined,
    }))

    return reply.status(200).send({ notifications, unreadCount })
  })

  // ---------------------------------------------------------------------------
  // POST /notifications/:id/read — mark a single notification as read
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/notifications/:id/read',
    { preHandler: requireAuth },
    async (req, reply) => {
      const recipientId = req.session!.sub!
      const { id } = req.params

      await pool.query(
        `UPDATE notifications SET read = true WHERE id = $1 AND recipient_id = $2`,
        [id, recipientId]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /notifications/read-all — mark all as read
  // ---------------------------------------------------------------------------

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (req, reply) => {
    const recipientId = req.session!.sub!

    await pool.query(
      `UPDATE notifications SET read = true WHERE recipient_id = $1 AND read = false`,
      [recipientId]
    )

    logger.info({ recipientId }, 'Notifications marked as read')
    return reply.status(200).send({ ok: true })
  })
}
