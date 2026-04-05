import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Comment Routes
//
// POST   /comments                      — Index a published comment
// GET    /comments/:targetEventId       — Fetch threaded comments for content
// DELETE /comments/:commentId           — Soft-delete a comment
// PATCH  /articles/:id/comments         — Toggle comments on an article
// PATCH  /notes/:id/comments            — Toggle comments on a note
// =============================================================================

const COMMENT_CHAR_LIMIT = 2000

const IndexCommentSchema = z.object({
  nostrEventId: z.string().min(1),
  targetEventId: z.string().min(1),
  targetKind: z.number().int(),
  parentCommentId: z.string().uuid().nullable().optional(),
  content: z.string().min(1).max(COMMENT_CHAR_LIMIT),
})

const ToggleCommentsSchema = z.object({
  enabled: z.boolean(),
})

export async function commentRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /comments — index a published comment
  // ---------------------------------------------------------------------------

  app.post('/comments', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = IndexCommentSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const authorId = req.session!.sub!
    const data = parsed.data

    try {
      // Verify target exists and comments are enabled
      let targetQuery
      if (data.targetKind === 30023) {
        targetQuery = await pool.query<{ writer_id: string; comments_enabled: boolean }>(
          `SELECT writer_id, comments_enabled FROM articles
           WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
          [data.targetEventId]
        )
      } else {
        targetQuery = await pool.query<{ author_id: string; comments_enabled: boolean }>(
          `SELECT author_id, comments_enabled FROM notes
           WHERE nostr_event_id = $1`,
          [data.targetEventId]
        )
      }

      if (targetQuery.rows.length === 0) {
        return reply.status(404).send({ error: 'Target content not found' })
      }

      const target = targetQuery.rows[0]
      if (!target.comments_enabled) {
        return reply.status(403).send({ error: 'Comments are disabled on this content' })
      }

      // Check if commenter is blocked by content author
      const contentAuthorId = 'writer_id' in target ? target.writer_id : target.author_id
      const blockCheck = await pool.query(
        `SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
        [contentAuthorId, authorId]
      )
      if (blockCheck.rows.length > 0) {
        return reply.status(403).send({ error: 'You cannot comment on this content' })
      }

      // If replying, verify parent exists and references same target
      if (data.parentCommentId) {
        const parentCheck = await pool.query<{ target_event_id: string }>(
          `SELECT target_event_id FROM comments WHERE id = $1 AND deleted_at IS NULL`,
          [data.parentCommentId]
        )
        if (parentCheck.rows.length === 0) {
          return reply.status(404).send({ error: 'Parent comment not found' })
        }
        if (parentCheck.rows[0].target_event_id !== data.targetEventId) {
          return reply.status(400).send({ error: 'Parent comment references different content' })
        }
      }

      const result = await pool.query<{ id: string }>(
        `INSERT INTO comments (
           author_id, nostr_event_id, target_event_id, target_kind,
           parent_comment_id, content, published_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (nostr_event_id) DO NOTHING
         RETURNING id`,
        [
          authorId,
          data.nostrEventId,
          data.targetEventId,
          data.targetKind,
          data.parentCommentId ?? null,
          data.content,
        ]
      )

      if (result.rows.length === 0) {
        return reply.status(200).send({ ok: true, duplicate: true })
      }

      // Record in feed_engagement for ranking
      await pool.query(
        `INSERT INTO feed_engagement (actor_id, target_nostr_event_id, target_author_id, engagement_type)
         VALUES ($1, $2, $3, 'reply')`,
        [authorId, data.targetEventId, contentAuthorId]
      ).catch(err => logger.warn({ err }, 'Failed to insert comment feed_engagement'))

      logger.info(
        { commentId: result.rows[0].id, authorId, targetEventId: data.targetEventId },
        'Comment indexed'
      )

      return reply.status(201).send({ commentId: result.rows[0].id })
    } catch (err) {
      logger.error({ err, authorId }, 'Comment indexing failed')
      return reply.status(500).send({ error: 'Comment indexing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /comments/:targetEventId — fetch threaded comments
  // ---------------------------------------------------------------------------

  app.get<{ Params: { targetEventId: string } }>(
    '/comments/:targetEventId',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { targetEventId } = req.params
      const currentUserId = req.session?.sub ?? null

      // Check if comments are enabled on target
      const articleCheck = await pool.query<{ comments_enabled: boolean }>(
        `SELECT comments_enabled FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
        [targetEventId]
      )
      const noteCheck = articleCheck.rows.length > 0
        ? articleCheck
        : await pool.query<{ comments_enabled: boolean }>(
            `SELECT comments_enabled FROM notes WHERE nostr_event_id = $1`,
            [targetEventId]
          )

      const commentsEnabled = noteCheck.rows[0]?.comments_enabled ?? true

      // Fetch all comments for this target
      const { rows } = await pool.query<{
        id: string
        nostr_event_id: string
        parent_comment_id: string | null
        content: string
        published_at: Date
        deleted_at: Date | null
        author_id: string
        author_username: string | null
        author_display_name: string | null
        author_avatar: string | null
      }>(
        `SELECT c.id, c.nostr_event_id, c.parent_comment_id,
                c.content, c.published_at, c.deleted_at,
                c.author_id,
                a.username AS author_username,
                a.display_name AS author_display_name,
                a.avatar_blossom_url AS author_avatar
         FROM comments c
         JOIN accounts a ON a.id = c.author_id
         WHERE c.target_event_id = $1
         ORDER BY c.published_at ASC`,
        [targetEventId]
      )

      // Get muted users for the current user (client-side filtering)
      let mutedIds: Set<string> = new Set()
      if (currentUserId) {
        const mutes = await pool.query<{ muted_id: string }>(
          'SELECT muted_id FROM mutes WHERE muter_id = $1',
          [currentUserId]
        )
        mutedIds = new Set(mutes.rows.map(r => r.muted_id))
      }

      // Build threaded tree (max 2 levels)
      interface CommentNode {
        id: string
        nostrEventId: string
        author: { id: string; username: string | null; displayName: string | null; avatar: string | null }
        content: string
        publishedAt: string
        isDeleted: boolean
        isMuted: boolean
        replies: CommentNode[]
      }

      const commentMap = new Map<string, CommentNode>()
      const topLevel: CommentNode[] = []

      for (const r of rows) {
        const node: CommentNode = {
          id: r.id,
          nostrEventId: r.nostr_event_id,
          author: {
            id: r.author_id,
            username: r.author_username,
            displayName: r.author_display_name,
            avatar: r.author_avatar,
          },
          content: r.deleted_at ? '[deleted]' : r.content,
          publishedAt: r.published_at.toISOString(),
          isDeleted: !!r.deleted_at,
          isMuted: mutedIds.has(r.author_id),
          replies: [],
        }
        commentMap.set(r.id, node)

        if (!r.parent_comment_id) {
          topLevel.push(node)
        } else {
          const parent = commentMap.get(r.parent_comment_id)
          if (parent) {
            // Flatten deep replies to level 2
            parent.replies.push(node)
          } else {
            topLevel.push(node)
          }
        }
      }

      return reply.status(200).send({
        comments: topLevel,
        totalCount: rows.filter(r => !r.deleted_at).length,
        commentsEnabled,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /comments/:commentId — soft-delete
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { commentId: string } }>(
    '/comments/:commentId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const { commentId } = req.params

      // Fetch the comment
      const { rows } = await pool.query<{
        author_id: string
        target_event_id: string
        target_kind: number
      }>(
        'SELECT author_id, target_event_id, target_kind FROM comments WHERE id = $1',
        [commentId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Comment not found' })
      }

      const comment = rows[0]

      // Check permission: comment author OR content author
      let isContentAuthor = false
      if (comment.target_kind === 30023) {
        const check = await pool.query(
          'SELECT 1 FROM articles WHERE nostr_event_id = $1 AND writer_id = $2',
          [comment.target_event_id, userId]
        )
        isContentAuthor = check.rows.length > 0
      } else {
        const check = await pool.query(
          'SELECT 1 FROM notes WHERE nostr_event_id = $1 AND author_id = $2',
          [comment.target_event_id, userId]
        )
        isContentAuthor = check.rows.length > 0
      }

      if (comment.author_id !== userId && !isContentAuthor) {
        return reply.status(403).send({ error: 'Not authorised to delete this comment' })
      }

      await pool.query(
        'UPDATE comments SET deleted_at = now() WHERE id = $1',
        [commentId]
      )

      logger.info({ commentId, userId }, 'Comment soft-deleted')
      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /articles/:id/comments — toggle comments on an article
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/articles/:id/comments',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = ToggleCommentsSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const writerId = req.session!.sub!
      const result = await pool.query(
        `UPDATE articles SET comments_enabled = $1
         WHERE id = $2 AND writer_id = $3 AND deleted_at IS NULL
         RETURNING id`,
        [parsed.data.enabled, req.params.id, writerId]
      )

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found or not owned by you' })
      }

      return reply.status(200).send({ ok: true, commentsEnabled: parsed.data.enabled })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /notes/:id/comments — toggle comments on a note
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/notes/:id/comments',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = ToggleCommentsSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const authorId = req.session!.sub!
      const result = await pool.query(
        `UPDATE notes SET comments_enabled = $1
         WHERE id = $2 AND author_id = $3
         RETURNING id`,
        [parsed.data.enabled, req.params.id, authorId]
      )

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Note not found or not owned by you' })
      }

      return reply.status(200).send({ ok: true, commentsEnabled: parsed.data.enabled })
    }
  )
}
