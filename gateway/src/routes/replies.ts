import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { checkArticleAccess } from "../services/article-access/index.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Reply Routes
//
// POST   /replies                      — Index a published reply
// GET    /replies/:targetEventId       — Fetch threaded replies for content
// DELETE /replies/:replyId             — Soft-delete a reply
// PATCH  /articles/:id/replies         — Toggle replies on an article
// PATCH  /notes/:id/replies            — Toggle replies on a note
// =============================================================================

const REPLY_CHAR_LIMIT = 2000;

const IndexReplySchema = z.object({
  nostrEventId: z.string().min(1),
  targetEventId: z.string().min(1),
  targetKind: z.number().int(),
  parentCommentId: z.string().uuid().nullable().optional(),
  content: z.string().min(1).max(REPLY_CHAR_LIMIT),
});

const ToggleRepliesSchema = z.object({
  enabled: z.boolean(),
});

// A single normalised node in a native conversation tree, used by
// GET /conversation/:eventId. The flat list + uniform parentEventId lets the
// client re-root on any node entirely client-side.
interface ConversationNode {
  eventId: string;
  // The comment's UUID (for delete); null for the root note/article.
  commentId: string | null;
  parentEventId: string | null;
  kind: number;
  isRoot: boolean;
  author: {
    id: string;
    username: string | null;
    displayName: string | null;
    avatar: string | null;
    pubkey: string;
    pipStatus: "known" | "partial" | "unknown" | "contested";
  };
  content: string;
  publishedAt: string;
  isDeleted: boolean;
  isMuted: boolean;
}

export async function replyRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /replies — index a published reply
  // ---------------------------------------------------------------------------

  app.post("/replies", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = IndexReplySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const authorId = req.session!.sub;
    const data = parsed.data;

    try {
      // Verify target exists and replies are enabled
      let targetQuery;
      if (data.targetKind === 30023) {
        targetQuery = await pool.query<{
          writer_id: string;
          comments_enabled: boolean;
        }>(
          `SELECT writer_id, comments_enabled FROM articles
           WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
          [data.targetEventId],
        );
      } else {
        targetQuery = await pool.query<{
          author_id: string;
          comments_enabled: boolean;
        }>(
          `SELECT author_id, comments_enabled FROM notes
           WHERE nostr_event_id = $1`,
          [data.targetEventId],
        );
      }

      if (targetQuery.rows.length === 0) {
        return reply.status(404).send({ error: "Target content not found" });
      }

      const target = targetQuery.rows[0];
      if (!target.comments_enabled) {
        return reply
          .status(403)
          .send({ error: "Replies are disabled on this content" });
      }

      // Check if replier is blocked by content author
      const contentAuthorId =
        "writer_id" in target ? target.writer_id : target.author_id;
      const blockCheck = await pool.query(
        `SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
        [contentAuthorId, authorId],
      );
      if (blockCheck.rows.length > 0) {
        return reply
          .status(403)
          .send({ error: "You cannot reply to this content" });
      }

      // If replying to another reply, verify parent exists and references same target
      if (data.parentCommentId) {
        const parentCheck = await pool.query<{ target_event_id: string }>(
          `SELECT target_event_id FROM comments WHERE id = $1 AND deleted_at IS NULL`,
          [data.parentCommentId],
        );
        if (parentCheck.rows.length === 0) {
          return reply.status(404).send({ error: "Parent reply not found" });
        }
        if (parentCheck.rows[0].target_event_id !== data.targetEventId) {
          return reply
            .status(400)
            .send({ error: "Parent reply references different content" });
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
        ],
      );

      if (result.rows.length === 0) {
        return reply.status(200).send({ ok: true, duplicate: true });
      }

      // Record in feed_engagement for ranking
      await pool
        .query(
          `INSERT INTO feed_engagement (actor_id, target_nostr_event_id, target_author_id, engagement_type)
         VALUES ($1, $2, $3, 'reply')`,
          [authorId, data.targetEventId, contentAuthorId],
        )
        .catch((err) =>
          logger.warn({ err }, "Failed to insert reply feed_engagement"),
        );

      // Resolve target article/note for notification context
      const articleRow =
        data.targetKind === 30023
          ? await pool
              .query<{
                id: string;
              }>(
                `SELECT id FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
                [data.targetEventId],
              )
              .then((r) => r.rows[0] ?? null)
          : null;
      const noteRow =
        data.targetKind === 1
          ? await pool
              .query<{
                id: string;
              }>(`SELECT id FROM notes WHERE nostr_event_id = $1`, [
                data.targetEventId,
              ])
              .then((r) => r.rows[0] ?? null)
          : null;

      // Notify content author of new reply (skip if replying to own content)
      if (authorId !== contentAuthorId) {
        pool
          .query(
            `INSERT INTO notifications (recipient_id, actor_id, type, article_id, note_id, comment_id)
           VALUES ($1, $2, 'new_reply', $3, $4, $5)
           ON CONFLICT DO NOTHING`,
            [
              contentAuthorId,
              authorId,
              articleRow?.id ?? null,
              noteRow?.id ?? null,
              result.rows[0].id,
            ],
          )
          .catch((err) =>
            logger.warn({ err }, "Failed to insert new_reply notification"),
          );
      }

      logger.info(
        {
          replyId: result.rows[0].id,
          authorId,
          targetEventId: data.targetEventId,
        },
        "Reply indexed",
      );

      // Notify @mentioned users (fire-and-forget)
      const mentionMatches = data.content.matchAll(
        /(?<![a-zA-Z0-9.])@([a-zA-Z0-9_]+)/g,
      );
      const mentionedUsernames = [
        ...new Set([...mentionMatches].map((m) => m[1])),
      ];
      if (mentionedUsernames.length > 0) {
        const { rows: mentionedUsers } = await pool.query<{ id: string }>(
          `SELECT id FROM accounts WHERE username = ANY($1) AND status = 'active' AND id != $2`,
          [mentionedUsernames, authorId],
        );
        for (const mentioned of mentionedUsers) {
          pool
            .query(
              `INSERT INTO notifications (recipient_id, actor_id, type, article_id, note_id)
             VALUES ($1, $2, 'new_mention', $3, $4)
             ON CONFLICT DO NOTHING`,
              [
                mentioned.id,
                authorId,
                articleRow?.id ?? null,
                noteRow?.id ?? null,
              ],
            )
            .catch((err) =>
              logger.warn({ err }, "Failed to insert mention notification"),
            );
        }
      }

      return reply.status(201).send({ commentId: result.rows[0].id });
    } catch (err) {
      logger.error({ err, authorId }, "Reply indexing failed");
      return reply.status(500).send({ error: "Reply indexing failed" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /replies/:targetEventId — fetch threaded replies
  // ---------------------------------------------------------------------------

  app.get<{ Params: { targetEventId: string } }>(
    "/replies/:targetEventId",
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { targetEventId } = req.params;
      const currentUserId = req.session?.sub ?? null;

      // Check if replies are enabled on target
      const articleCheck = await pool.query<{ comments_enabled: boolean }>(
        `SELECT comments_enabled FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
        [targetEventId],
      );
      const noteCheck =
        articleCheck.rows.length > 0
          ? articleCheck
          : await pool.query<{ comments_enabled: boolean }>(
              `SELECT comments_enabled FROM notes WHERE nostr_event_id = $1`,
              [targetEventId],
            );

      const repliesEnabled = noteCheck.rows[0]?.comments_enabled ?? true;

      // If target is a paywalled article, check that the reader has access
      if (articleCheck.rows.length > 0) {
        const articleRow = await pool.query<{
          id: string;
          access_mode: string;
          writer_id: string;
          publication_id: string | null;
        }>(
          `SELECT id, access_mode, writer_id, publication_id
           FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
          [targetEventId],
        );
        const art = articleRow.rows[0];
        if (art && art.access_mode === "paywalled") {
          let hasAccess = false;
          if (currentUserId) {
            const access = await checkArticleAccess(
              currentUserId,
              art.id,
              art.writer_id,
              art.publication_id,
            );
            hasAccess = access.hasAccess;
          }
          if (!hasAccess) {
            return reply.status(200).send({
              comments: [],
              totalCount: 0,
              repliesEnabled,
              commentsEnabled: repliesEnabled,
              paywallLocked: true,
            });
          }
        }
      }

      // Fetch all replies for this target
      const { rows } = await pool.query<{
        id: string;
        nostr_event_id: string;
        parent_comment_id: string | null;
        content: string;
        published_at: Date;
        deleted_at: Date | null;
        author_id: string;
        author_username: string | null;
        author_display_name: string | null;
        author_avatar: string | null;
        author_pip_status: "known" | "partial" | "unknown" | "contested" | null;
      }>(
        `SELECT c.id, c.nostr_event_id, c.parent_comment_id,
                c.content, c.published_at, c.deleted_at,
                c.author_id,
                a.username AS author_username,
                a.display_name AS author_display_name,
                a.avatar_blossom_url AS author_avatar,
                tl.pip_status AS author_pip_status
         FROM comments c
         JOIN accounts a ON a.id = c.author_id
         LEFT JOIN trust_layer1 tl ON tl.user_id = c.author_id
         WHERE c.target_event_id = $1
         ORDER BY c.published_at ASC`,
        [targetEventId],
      );

      // Get muted users for the current user
      let mutedIds: Set<string> = new Set();
      if (currentUserId) {
        const mutes = await pool.query<{ muted_id: string }>(
          "SELECT muted_id FROM mutes WHERE muter_id = $1",
          [currentUserId],
        );
        mutedIds = new Set(mutes.rows.map((r) => r.muted_id));
      }

      // Build threaded tree (max 2 levels)
      interface ReplyNode {
        id: string;
        nostrEventId: string;
        author: {
          id: string;
          username: string | null;
          displayName: string | null;
          avatar: string | null;
          pipStatus: "known" | "partial" | "unknown" | "contested";
        };
        parentCommentId: string | null;
        content: string;
        publishedAt: string;
        isDeleted: boolean;
        isMuted: boolean;
        replies: ReplyNode[];
      }

      const replyMap = new Map<string, ReplyNode>();
      const topLevel: ReplyNode[] = [];

      for (const r of rows) {
        const node: ReplyNode = {
          id: r.id,
          nostrEventId: r.nostr_event_id,
          author: {
            id: r.author_id,
            username: r.author_username,
            displayName: r.author_display_name,
            avatar: r.author_avatar,
            pipStatus: r.author_pip_status ?? "unknown",
          },
          parentCommentId: r.parent_comment_id,
          content: r.deleted_at ? "[deleted]" : r.content,
          publishedAt: r.published_at.toISOString(),
          isDeleted: !!r.deleted_at,
          isMuted: mutedIds.has(r.author_id),
          replies: [],
        };
        replyMap.set(r.id, node);

        if (!r.parent_comment_id) {
          topLevel.push(node);
        } else {
          const parent = replyMap.get(r.parent_comment_id);
          if (parent) {
            parent.replies.push(node);
          } else {
            topLevel.push(node);
          }
        }
      }

      return reply.status(200).send({
        comments: topLevel,
        totalCount: rows.filter((r) => !r.deleted_at).length,
        repliesEnabled,
        commentsEnabled: repliesEnabled, // backwards-compat alias
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /conversation/:eventId — full conversation for in-place neighbourhood
  //
  // Given ANY node in a native conversation (a top-level note/article event id,
  // or a comment's own event id), resolve the conversation root and return the
  // whole conversation as a flat list of normalised nodes. Each node carries a
  // uniform `parentEventId` (null for the root; the root's event id for
  // top-level comments; the parent comment's event id otherwise), so the client
  // can re-root the view on any node — rendering that node's ancestors above it
  // and its descendants below — without another fetch.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { eventId: string } }>(
    "/conversation/:eventId",
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { eventId } = req.params;
      const currentUserId = req.session?.sub ?? null;

      // 1. Resolve the conversation root. If the requested event is a comment,
      //    the root is whatever it targets; otherwise the event IS the root.
      const commentRow = await pool.query<{
        target_event_id: string;
        target_kind: number;
      }>(
        `SELECT target_event_id, target_kind FROM comments WHERE nostr_event_id = $1`,
        [eventId],
      );
      const rootEventId = commentRow.rows[0]?.target_event_id ?? eventId;

      // 2. Fetch the root node — a native note (kind 1) or an article (30023).
      const rootNote = await pool.query<{
        nostr_event_id: string;
        content: string;
        published_at: Date;
        comments_enabled: boolean;
        author_id: string;
        author_username: string | null;
        author_display_name: string | null;
        author_avatar: string | null;
        author_pubkey: string;
        author_pip_status:
          | "known"
          | "partial"
          | "unknown"
          | "contested"
          | null;
      }>(
        `SELECT n.nostr_event_id, n.content, n.published_at, n.comments_enabled,
                n.author_id,
                a.username AS author_username,
                a.display_name AS author_display_name,
                a.avatar_blossom_url AS author_avatar,
                a.nostr_pubkey AS author_pubkey,
                tl.pip_status AS author_pip_status
         FROM notes n
         JOIN accounts a ON a.id = n.author_id
         LEFT JOIN trust_layer1 tl ON tl.user_id = n.author_id
         WHERE n.nostr_event_id = $1`,
        [rootEventId],
      );

      let rootNode: ConversationNode | null = null;
      let rootKind = 1;
      let repliesEnabled = true;

      if (rootNote.rows.length > 0) {
        const r = rootNote.rows[0];
        repliesEnabled = r.comments_enabled;
        rootNode = {
          eventId: r.nostr_event_id,
          commentId: null,
          parentEventId: null,
          kind: 1,
          isRoot: true,
          author: {
            id: r.author_id,
            username: r.author_username,
            displayName: r.author_display_name,
            avatar: r.author_avatar,
            pubkey: r.author_pubkey,
            pipStatus: r.author_pip_status ?? "unknown",
          },
          content: r.content,
          publishedAt: r.published_at.toISOString(),
          isDeleted: false,
          isMuted: false,
        };
      } else {
        // Root may be an article (kind 30023). Title stands in for content as the
        // conversation anchor; paywalled article bodies are never exposed here.
        const rootArticle = await pool.query<{
          id: string;
          nostr_event_id: string;
          title: string | null;
          comments_enabled: boolean;
          access_mode: string;
          writer_id: string;
          publication_id: string | null;
          published_at: Date | null;
          author_username: string | null;
          author_display_name: string | null;
          author_avatar: string | null;
          author_pubkey: string;
          author_pip_status:
            | "known"
            | "partial"
            | "unknown"
            | "contested"
            | null;
        }>(
          `SELECT ar.id, ar.nostr_event_id, ar.title, ar.comments_enabled,
                  ar.access_mode, ar.writer_id, ar.publication_id, ar.published_at,
                  a.username AS author_username,
                  a.display_name AS author_display_name,
                  a.avatar_blossom_url AS author_avatar,
                  a.nostr_pubkey AS author_pubkey,
                  tl.pip_status AS author_pip_status
           FROM articles ar
           JOIN accounts a ON a.id = ar.writer_id
           LEFT JOIN trust_layer1 tl ON tl.user_id = ar.writer_id
           WHERE ar.nostr_event_id = $1 AND ar.deleted_at IS NULL`,
          [rootEventId],
        );
        if (rootArticle.rows.length > 0) {
          const r = rootArticle.rows[0];
          rootKind = 30023;
          repliesEnabled = r.comments_enabled;
          // Gate paywalled article conversations the same way /replies does.
          if (r.access_mode === "paywalled") {
            let hasAccess = false;
            if (currentUserId) {
              const access = await checkArticleAccess(
                currentUserId,
                r.id,
                r.writer_id,
                r.publication_id,
              );
              hasAccess = access.hasAccess;
            }
            if (!hasAccess) {
              return reply.status(200).send({
                rootEventId,
                rootKind,
                repliesEnabled,
                paywallLocked: true,
                nodes: [],
              });
            }
          }
          rootNode = {
            eventId: r.nostr_event_id,
            commentId: null,
            parentEventId: null,
            kind: 30023,
            isRoot: true,
            author: {
              id: r.writer_id,
              username: r.author_username,
              displayName: r.author_display_name,
              avatar: r.author_avatar,
              pubkey: r.author_pubkey,
              pipStatus: r.author_pip_status ?? "unknown",
            },
            content: r.title ?? "",
            publishedAt: (r.published_at ?? new Date(0)).toISOString(),
            isDeleted: false,
            isMuted: false,
          };
        }
      }

      // 3. Fetch every comment in the conversation (same shape as /replies).
      const { rows: commentRows } = await pool.query<{
        id: string;
        nostr_event_id: string;
        parent_comment_id: string | null;
        content: string;
        published_at: Date;
        deleted_at: Date | null;
        author_id: string;
        author_username: string | null;
        author_display_name: string | null;
        author_avatar: string | null;
        author_pubkey: string;
        author_pip_status: "known" | "partial" | "unknown" | "contested" | null;
        parent_event_id: string | null;
      }>(
        `SELECT c.id, c.nostr_event_id, c.parent_comment_id,
                c.content, c.published_at, c.deleted_at,
                c.author_id,
                a.username AS author_username,
                a.display_name AS author_display_name,
                a.avatar_blossom_url AS author_avatar,
                a.nostr_pubkey AS author_pubkey,
                tl.pip_status AS author_pip_status,
                p.nostr_event_id AS parent_event_id
         FROM comments c
         JOIN accounts a ON a.id = c.author_id
         LEFT JOIN trust_layer1 tl ON tl.user_id = c.author_id
         LEFT JOIN comments p ON p.id = c.parent_comment_id
         WHERE c.target_event_id = $1
         ORDER BY c.published_at ASC`,
        [rootEventId],
      );

      // Muted users for the viewer.
      let mutedIds: Set<string> = new Set();
      if (currentUserId) {
        const mutes = await pool.query<{ muted_id: string }>(
          "SELECT muted_id FROM mutes WHERE muter_id = $1",
          [currentUserId],
        );
        mutedIds = new Set(mutes.rows.map((r) => r.muted_id));
      }

      const nodes: ConversationNode[] = [];
      if (rootNode) nodes.push(rootNode);
      for (const c of commentRows) {
        nodes.push({
          eventId: c.nostr_event_id,
          commentId: c.id,
          // Top-level comments hang off the root; nested ones off their parent
          // comment. A NULL parent_event_id (orphaned nesting) falls back to the
          // root so the node still attaches somewhere walkable.
          parentEventId: c.parent_comment_id
            ? (c.parent_event_id ?? rootEventId)
            : rootEventId,
          kind: 1,
          isRoot: false,
          author: {
            id: c.author_id,
            username: c.author_username,
            displayName: c.author_display_name,
            avatar: c.author_avatar,
            pubkey: c.author_pubkey,
            pipStatus: c.author_pip_status ?? "unknown",
          },
          content: c.deleted_at ? "[deleted]" : c.content,
          publishedAt: c.published_at.toISOString(),
          isDeleted: !!c.deleted_at,
          isMuted: mutedIds.has(c.author_id),
        });
      }

      return reply.status(200).send({
        rootEventId,
        rootKind,
        repliesEnabled,
        paywallLocked: false,
        nodes,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /replies/:replyId — soft-delete
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { replyId: string } }>(
    "/replies/:replyId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const { replyId } = req.params;

      const { rows } = await pool.query<{
        author_id: string;
        target_event_id: string;
        target_kind: number;
      }>(
        "SELECT author_id, target_event_id, target_kind FROM comments WHERE id = $1",
        [replyId],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Reply not found" });
      }

      const replyRow = rows[0];

      // Check permission: reply author OR content author
      let isContentAuthor = false;
      if (replyRow.target_kind === 30023) {
        const check = await pool.query(
          "SELECT 1 FROM articles WHERE nostr_event_id = $1 AND writer_id = $2",
          [replyRow.target_event_id, userId],
        );
        isContentAuthor = check.rows.length > 0;
      } else {
        const check = await pool.query(
          "SELECT 1 FROM notes WHERE nostr_event_id = $1 AND author_id = $2",
          [replyRow.target_event_id, userId],
        );
        isContentAuthor = check.rows.length > 0;
      }

      if (replyRow.author_id !== userId && !isContentAuthor) {
        return reply
          .status(403)
          .send({ error: "Not authorised to delete this reply" });
      }

      await pool.query("UPDATE comments SET deleted_at = now() WHERE id = $1", [
        replyId,
      ]);

      logger.info({ replyId, userId }, "Reply soft-deleted");
      return reply.status(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /articles/:id/replies — toggle replies on an article
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    "/articles/:id/replies",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = ToggleRepliesSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const writerId = req.session!.sub;
      const result = await pool.query(
        `UPDATE articles SET comments_enabled = $1
         WHERE id = $2 AND writer_id = $3 AND deleted_at IS NULL
         RETURNING id`,
        [parsed.data.enabled, req.params.id, writerId],
      );

      if (result.rows.length === 0) {
        return reply
          .status(404)
          .send({ error: "Article not found or not owned by you" });
      }

      return reply
        .status(200)
        .send({ ok: true, repliesEnabled: parsed.data.enabled });
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /notes/:id/replies — toggle replies on a note
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    "/notes/:id/replies",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = ToggleRepliesSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const authorId = req.session!.sub;
      const result = await pool.query(
        `UPDATE notes SET comments_enabled = $1
         WHERE id = $2 AND author_id = $3
         RETURNING id`,
        [parsed.data.enabled, req.params.id, authorId],
      );

      if (result.rows.length === 0) {
        return reply
          .status(404)
          .send({ error: "Note not found or not owned by you" });
      }

      return reply
        .status(200)
        .send({ ok: true, repliesEnabled: parsed.data.enabled });
    },
  );
}
