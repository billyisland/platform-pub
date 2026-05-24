import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import { requireAuth } from "../middleware/auth.js";
import {
  enqueueCrossPost,
  enqueueLike,
  enqueueRepost,
  enqueueNostrOutbound,
} from "../lib/outbound-enqueue.js";
import { signEvent } from "../lib/key-custody-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

const APPVIEW = "https://public.api.bsky.app";

// In-memory TTL cache to prevent rapid re-fetches (30s per item)
const engagementCache = new Map<
  string,
  { data: EngagementResponse; expiresAt: number }
>();
const CACHE_TTL_MS = 30_000;

const parentCache = new Map<
  string,
  { data: ParentContextResponse; expiresAt: number }
>();
const PARENT_CACHE_TTL_MS = 120_000;

const threadCache = new Map<
  string,
  { data: ThreadResponse; expiresAt: number }
>();
const THREAD_CACHE_TTL_MS = 60_000;

interface ExternalThreadEntry {
  id: string;
  authorName: string;
  authorHandle: string;
  authorUri: string;
  contentHtml: string;
  contentText: string;
  publishedAt: string;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  parentId: string | null;
  protocol: string;
}

interface ThreadResponse {
  ancestors: ExternalThreadEntry[];
  descendants: ExternalThreadEntry[];
}

interface EngagementResponse {
  likeCount: number;
  replyCount: number;
  repostCount: number;
  protocol: string;
  fetchedAt: string;
}

interface ParentContextResponse {
  parent: ParentItem | null;
  grandparentTag: { authorName: string; authorHandle: string } | null;
}

interface ParentItem {
  id: string;
  sourceProtocol: string;
  sourceItemUri: string;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  title: string | null;
  summary: string | null;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  media: unknown[];
  publishedAt: number;
  sourceReplyUri: string | null;
}

interface ExternalItemRow {
  id: string;
  source_id: string;
  protocol: string;
  source_item_uri: string;
  source_reply_uri: string | null;
  like_count: number;
  reply_count: number;
  repost_count: number;
  interaction_data: Record<string, unknown>;
}

export async function externalItemsRoutes(app: FastifyInstance) {
  // =========================================================================
  // GET /external-items/:id/engagement — live engagement counts from source
  // =========================================================================
  app.get<{ Params: { id: string } }>(
    "/external-items/:id/engagement",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;

      const cached = engagementCache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      const { rows } = await pool.query<ExternalItemRow>(
        `SELECT id, protocol, source_item_uri, like_count, reply_count, repost_count
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }

      const item = rows[0];
      let likeCount = item.like_count;
      let replyCount = item.reply_count;
      let repostCount = item.repost_count;

      if (item.protocol === "atproto") {
        const live = await fetchBlueskyEngagement(item.source_item_uri);
        if (live) {
          likeCount = live.likeCount;
          replyCount = live.replyCount;
          repostCount = live.repostCount;
        }
      } else if (item.protocol === "activitypub") {
        const live = await fetchMastodonEngagement(item.source_item_uri);
        if (live) {
          likeCount = live.likeCount;
          replyCount = live.replyCount;
          repostCount = live.repostCount;
        }
      }
      // nostr_external + rss: return stored snapshot

      // Side-effect: update snapshot columns
      if (
        likeCount !== item.like_count ||
        replyCount !== item.reply_count ||
        repostCount !== item.repost_count
      ) {
        pool
          .query(
            `UPDATE external_items SET like_count = $1, reply_count = $2, repost_count = $3 WHERE id = $4`,
            [likeCount, replyCount, repostCount, id],
          )
          .catch((err) =>
            logger.warn({ err, id }, "Failed to update engagement snapshot"),
          );
      }

      const data: EngagementResponse = {
        likeCount,
        replyCount,
        repostCount,
        protocol: item.protocol,
        fetchedAt: new Date().toISOString(),
      };

      engagementCache.set(id, { data, expiresAt: Date.now() + CACHE_TTL_MS });

      return reply.send(data);
    },
  );

  // =========================================================================
  // GET /external-items/:id/parent — parent context tile for reply items
  // =========================================================================
  app.get<{ Params: { id: string } }>(
    "/external-items/:id/parent",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;

      const cached = parentCache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      const { rows } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_reply_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }

      const item = rows[0];

      if (!item.source_reply_uri) {
        const data: ParentContextResponse = {
          parent: null,
          grandparentTag: null,
        };
        return reply.send(data);
      }

      // Check if parent already exists in external_items
      const { rows: parentRows } = await pool.query(
        `SELECT id, protocol, source_item_uri, source_reply_uri,
                author_name, author_handle, author_avatar_url, author_uri,
                content_text, content_html, title, summary, media,
                like_count, reply_count, repost_count, interaction_data,
                EXTRACT(EPOCH FROM published_at)::bigint AS published_at_epoch
         FROM external_items
         WHERE source_item_uri = $1 AND protocol = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [item.source_reply_uri, item.protocol],
      );

      let parent: ParentItem | null = null;
      let grandparentTag: { authorName: string; authorHandle: string } | null =
        null;

      if (parentRows.length > 0) {
        const row = parentRows[0];
        parent = rowToParentItem(row);
        grandparentTag = extractGrandparentTag(row);
      } else {
        // Fetch from source platform
        const fetched = await fetchParentFromSource(item);
        if (fetched) {
          parent = fetched.parent;
          grandparentTag = fetched.grandparentTag;
        }
      }

      const data: ParentContextResponse = { parent, grandparentTag };
      parentCache.set(id, {
        data,
        expiresAt: Date.now() + PARENT_CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );

  // =========================================================================
  // GET /external-items/:id/thread — full reply thread from source platform
  // =========================================================================
  app.get<{ Params: { id: string } }>(
    "/external-items/:id/thread",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;

      const cached = threadCache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      const { rows } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_reply_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }

      const item = rows[0];
      let data: ThreadResponse = { ancestors: [], descendants: [] };

      if (item.protocol === "atproto") {
        const thread = await fetchBlueskyThread(item);
        if (thread) data = thread;
      } else if (item.protocol === "activitypub") {
        const thread = await fetchMastodonThread(item);
        if (thread) data = thread;
      }
      // nostr_external + rss: return empty thread

      threadCache.set(id, {
        data,
        expiresAt: Date.now() + THREAD_CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );

  // =========================================================================
  // POST /external-items/:id/like — like/favourite on source platform
  // =========================================================================
  app.post<{ Params: { id: string }; Body: { linkedAccountId: string } }>(
    "/external-items/:id/like",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;
      const { linkedAccountId } = req.body ?? {};
      const accountId = (req as any).userId as string;

      if (!linkedAccountId) {
        return reply.status(400).send({ error: "linkedAccountId is required" });
      }

      // Load item
      const { rows: items } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_reply_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (items.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }
      const item = items[0];

      if (item.protocol === "rss") {
        return reply
          .status(422)
          .send({ error: "Likes are not supported for RSS items" });
      }

      // Validate linked account ownership + protocol match
      const { rows: la } = await pool.query<{
        protocol: string;
        is_valid: boolean;
      }>(
        `SELECT protocol, is_valid FROM linked_accounts
         WHERE id = $1 AND account_id = $2`,
        [linkedAccountId, accountId],
      );
      if (la.length === 0) {
        return reply.status(403).send({ error: "Linked account not found" });
      }
      if (!la[0].is_valid) {
        return reply
          .status(422)
          .send({ error: "Linked account is invalid — reconnect in settings" });
      }
      if (la[0].protocol !== item.protocol) {
        return reply.status(422).send({
          error: `Linked account protocol (${la[0].protocol}) does not match item protocol (${item.protocol})`,
        });
      }

      try {
        if (item.protocol === "nostr_external") {
          // Sign a kind 7 reaction event and enqueue via Nostr outbound
          const signed = await signEvent(accountId, {
            kind: 7,
            content: "+",
            tags: [["e", item.source_item_uri]],
            created_at: Math.floor(Date.now() / 1000),
          });
          await enqueueNostrOutbound({
            accountId,
            sourceItemId: id,
            nostrEventId: signed.id,
            bodyText: "",
            signedEvent: signed,
            actionType: "like",
          });
        } else {
          await enqueueLike({
            accountId,
            linkedAccountId,
            sourceItemId: id,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, itemId: id, accountId }, "Like enqueue failed");
        return reply.status(500).send({ error: "Failed to enqueue like" });
      }

      return reply.status(202).send({ status: "accepted" });
    },
  );

  // =========================================================================
  // POST /external-items/:id/repost — repost/boost on source platform
  // =========================================================================
  app.post<{ Params: { id: string }; Body: { linkedAccountId: string } }>(
    "/external-items/:id/repost",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;
      const { linkedAccountId } = req.body ?? {};
      const accountId = (req as any).userId as string;

      if (!linkedAccountId) {
        return reply.status(400).send({ error: "linkedAccountId is required" });
      }

      // Load item
      const { rows: items } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_reply_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (items.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }
      const item = items[0];

      if (item.protocol === "rss" || item.protocol === "nostr_external") {
        return reply
          .status(422)
          .send({ error: "Reposts are not supported for this protocol" });
      }

      // Validate linked account ownership + protocol match
      const { rows: la } = await pool.query<{
        protocol: string;
        is_valid: boolean;
      }>(
        `SELECT protocol, is_valid FROM linked_accounts
         WHERE id = $1 AND account_id = $2`,
        [linkedAccountId, accountId],
      );
      if (la.length === 0) {
        return reply.status(403).send({ error: "Linked account not found" });
      }
      if (!la[0].is_valid) {
        return reply
          .status(422)
          .send({ error: "Linked account is invalid — reconnect in settings" });
      }
      if (la[0].protocol !== item.protocol) {
        return reply.status(422).send({
          error: `Linked account protocol (${la[0].protocol}) does not match item protocol (${item.protocol})`,
        });
      }

      try {
        await enqueueRepost({
          accountId,
          linkedAccountId,
          sourceItemId: id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err: msg, itemId: id, accountId },
          "Repost enqueue failed",
        );
        return reply.status(500).send({ error: "Failed to enqueue repost" });
      }

      return reply.status(202).send({ status: "accepted" });
    },
  );

  // =========================================================================
  // POST /external-items/:id/reply — reply on source platform + create note
  // =========================================================================
  const NOTE_CHAR_LIMIT = 1000;

  app.post<{
    Params: { id: string };
    Body: { linkedAccountId: string; content: string };
  }>(
    "/external-items/:id/reply",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;
      const { linkedAccountId, content } = req.body ?? {};
      const accountId = (req as any).userId as string;

      if (!linkedAccountId) {
        return reply.status(400).send({ error: "linkedAccountId is required" });
      }
      if (
        !content ||
        typeof content !== "string" ||
        content.trim().length === 0
      ) {
        return reply.status(400).send({ error: "content is required" });
      }
      if (content.length > NOTE_CHAR_LIMIT) {
        return reply
          .status(400)
          .send({ error: `content exceeds ${NOTE_CHAR_LIMIT} characters` });
      }

      // Load item + source relay URLs (needed for nostr_external outbound)
      const { rows: items } = await pool.query<
        ExternalItemRow & { relay_urls: string[] | null }
      >(
        `SELECT ei.id, ei.source_id, ei.protocol, ei.source_item_uri,
                ei.source_reply_uri, ei.like_count, ei.reply_count,
                ei.repost_count, ei.interaction_data,
                xs.relay_urls
         FROM external_items ei
         JOIN external_sources xs ON xs.id = ei.source_id
         WHERE ei.id = $1 AND ei.deleted_at IS NULL`,
        [id],
      );
      if (items.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }
      const item = items[0];

      if (item.protocol === "rss") {
        return reply
          .status(422)
          .send({ error: "Replies are not supported for RSS items" });
      }

      // Validate linked account ownership + protocol match
      const { rows: la } = await pool.query<{
        protocol: string;
        is_valid: boolean;
      }>(
        `SELECT protocol, is_valid FROM linked_accounts
         WHERE id = $1 AND account_id = $2`,
        [linkedAccountId, accountId],
      );
      if (la.length === 0) {
        return reply.status(403).send({ error: "Linked account not found" });
      }
      if (!la[0].is_valid) {
        return reply
          .status(422)
          .send({ error: "Linked account is invalid — reconnect in settings" });
      }
      if (la[0].protocol !== item.protocol) {
        return reply.status(422).send({
          error: `Linked account protocol (${la[0].protocol}) does not match item protocol (${item.protocol})`,
        });
      }

      const trimmed = content.trim();

      // Build Nostr kind 1 event tags
      const tags: string[][] = [];
      if (item.protocol === "nostr_external") {
        tags.push(["e", item.source_item_uri, "", "root"]);
        const authorPubkey = (item.interaction_data as Record<string, unknown>)
          ?.pubkey;
        if (typeof authorPubkey === "string") {
          tags.push(["p", authorPubkey]);
        }
      }

      // Sign kind 1 Nostr event via key-custody
      let signed: Awaited<ReturnType<typeof signEvent>>;
      try {
        signed = await signEvent(accountId, {
          kind: 1,
          content: trimmed,
          tags,
          created_at: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        logger.error({ err, accountId }, "Failed to sign reply event");
        return reply.status(500).send({ error: "Failed to sign event" });
      }

      // Create note + feed_items + enqueue relay publish in one transaction
      let noteId: string;
      try {
        const result = await withTransaction(async (client) => {
          // Fetch author metadata for feed_items denormalisation
          const {
            rows: [author],
          } = await client.query<{
            display_name: string | null;
            avatar_blossom_url: string | null;
            username: string | null;
          }>(
            `SELECT display_name, avatar_blossom_url, username FROM accounts WHERE id = $1`,
            [accountId],
          );

          const { rows: noteRows } = await client.query<{ id: string }>(
            `INSERT INTO notes (
               author_id, nostr_event_id, content, char_count, tier,
               published_at, external_parent_id
             ) VALUES ($1, $2, $3, $4, 'tier1', now(), $5)
             ON CONFLICT (nostr_event_id) DO NOTHING
             RETURNING id`,
            [accountId, signed.id, trimmed, trimmed.length, id],
          );

          if (noteRows.length === 0) {
            return { noteId: null, duplicate: true };
          }

          const nId = noteRows[0].id;

          await client.query(
            `INSERT INTO feed_items (
               item_type, note_id, author_id,
               author_name, author_avatar, author_username,
               content_preview, nostr_event_id,
               tier, published_at
             ) VALUES (
               'note', $1, $2,
               $3, $4, $5,
               $6, $7,
               'tier1', now()
             )
             ON CONFLICT (note_id) WHERE note_id IS NOT NULL DO UPDATE SET
               content_preview = EXCLUDED.content_preview,
               author_name = EXCLUDED.author_name,
               author_avatar = EXCLUDED.author_avatar,
               author_username = EXCLUDED.author_username`,
            [
              nId,
              accountId,
              author?.display_name ?? author?.username ?? "Unknown",
              author?.avatar_blossom_url ?? null,
              author?.username ?? null,
              truncatePreview(trimmed),
              signed.id,
            ],
          );

          await enqueueRelayPublish(client, {
            entityType: "note",
            entityId: nId,
            signedEvent: signed as SignedNostrEvent,
          });

          return { noteId: nId, duplicate: false };
        });

        if (result.duplicate || !result.noteId) {
          return reply.status(200).send({ ok: true, duplicate: true });
        }
        noteId = result.noteId;
      } catch (err) {
        logger.error({ err, accountId }, "Reply note creation failed");
        return reply.status(500).send({ error: "Failed to create reply note" });
      }

      // Best-effort: enqueue outbound cross-post
      try {
        if (item.protocol === "nostr_external") {
          await enqueueNostrOutbound({
            accountId,
            sourceItemId: id,
            nostrEventId: signed.id,
            bodyText: trimmed,
            signedEvent: signed,
            actionType: "reply",
          });
        } else {
          await enqueueCrossPost({
            accountId,
            linkedAccountId,
            sourceItemId: id,
            actionType: "reply",
            nostrEventId: signed.id,
            bodyText: trimmed,
          });
        }
      } catch (err) {
        logger.warn(
          { err, noteId, itemId: id, accountId },
          "Reply cross-post enqueue failed (note created successfully)",
        );
      }

      logger.info(
        { noteId, nostrEventId: signed.id, itemId: id, accountId },
        "External reply note created",
      );

      return reply.status(201).send({ noteId, nostrEventId: signed.id });
    },
  );
}

// ---------------------------------------------------------------------------
// Bluesky engagement fetch
// ---------------------------------------------------------------------------

async function fetchBlueskyEngagement(uri: string): Promise<{
  likeCount: number;
  replyCount: number;
  repostCount: number;
} | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", uri);

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as {
      posts: Array<{
        uri: string;
        likeCount?: number;
        replyCount?: number;
        repostCount?: number;
      }>;
    };

    const post = data.posts?.[0];
    if (!post) return null;

    return {
      likeCount: post.likeCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), uri },
      "Bluesky engagement fetch failed",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mastodon engagement fetch
// ---------------------------------------------------------------------------

async function fetchMastodonEngagement(uri: string): Promise<{
  likeCount: number;
  replyCount: number;
  repostCount: number;
} | null> {
  const statusId = extractMastodonStatusId(uri);
  if (!statusId) return null;

  try {
    const host = new URL(uri).hostname;
    const res = await safeFetch(`https://${host}/api/v1/statuses/${statusId}`, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const status = JSON.parse(res.text) as {
      favourites_count?: number;
      replies_count?: number;
      reblogs_count?: number;
    };

    return {
      likeCount: status.favourites_count ?? 0,
      replyCount: status.replies_count ?? 0,
      repostCount: status.reblogs_count ?? 0,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), uri },
      "Mastodon engagement fetch failed",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parent context fetch from source platform
// ---------------------------------------------------------------------------

async function fetchParentFromSource(childItem: ExternalItemRow): Promise<{
  parent: ParentItem;
  grandparentTag: { authorName: string; authorHandle: string } | null;
} | null> {
  const parentUri = childItem.source_reply_uri!;

  if (childItem.protocol === "atproto") {
    return fetchBlueskyParent(parentUri, childItem.source_id);
  }

  if (childItem.protocol === "activitypub") {
    return fetchMastodonParent(parentUri, childItem.source_id);
  }

  return null;
}

async function fetchBlueskyParent(
  parentUri: string,
  sourceId: string,
): Promise<{
  parent: ParentItem;
  grandparentTag: { authorName: string; authorHandle: string } | null;
} | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", parentUri);

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as {
      posts: Array<{
        uri: string;
        cid: string;
        author: {
          did: string;
          handle: string;
          displayName?: string;
          avatar?: string;
        };
        record: {
          text?: string;
          createdAt?: string;
          reply?: { parent: { uri: string }; root: { uri: string } };
        };
        likeCount?: number;
        replyCount?: number;
        repostCount?: number;
        embed?: unknown;
      }>;
    };

    const post = data.posts?.[0];
    if (!post) return null;

    const publishedAt = post.record.createdAt
      ? Math.floor(new Date(post.record.createdAt).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const parentReplyUri = post.record.reply?.parent.uri ?? null;

    // Store in DB as context-only
    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_text, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'post', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count
      RETURNING id`,
      [
        sourceId,
        "atproto",
        parentUri,
        post.author.displayName || post.author.handle,
        post.author.handle,
        post.author.avatar ?? null,
        `https://bsky.app/profile/${post.author.did}`,
        post.record.text ?? null,
        JSON.stringify([]),
        parentReplyUri,
        JSON.stringify({ uri: post.uri, cid: post.cid }),
        post.likeCount ?? 0,
        post.replyCount ?? 0,
        post.repostCount ?? 0,
        new Date(post.record.createdAt ?? Date.now()),
      ],
    );

    const parent: ParentItem = {
      id: insertResult.rows[0].id,
      sourceProtocol: "atproto",
      sourceItemUri: parentUri,
      authorName: post.author.displayName || post.author.handle,
      authorHandle: post.author.handle,
      authorAvatarUrl: post.author.avatar ?? null,
      authorUri: `https://bsky.app/profile/${post.author.did}`,
      contentText: post.record.text ?? null,
      contentHtml: null,
      title: null,
      summary: null,
      likeCount: post.likeCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
      media: [],
      publishedAt: publishedAt,
      sourceReplyUri: parentReplyUri,
    };

    // Grandparent: if the parent is itself a reply, we got basic info already
    let grandparentTag: {
      authorName: string;
      authorHandle: string;
    } | null = null;
    if (parentReplyUri) {
      // Try to get grandparent author — fetch is best-effort
      const gpTag = await fetchBlueskyGrandparentTag(parentReplyUri);
      if (gpTag) grandparentTag = gpTag;
    }

    return { parent, grandparentTag };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), parentUri },
      "Bluesky parent fetch failed",
    );
    return null;
  }
}

async function fetchBlueskyGrandparentTag(
  uri: string,
): Promise<{ authorName: string; authorHandle: string } | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", uri);

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as {
      posts: Array<{
        author: { handle: string; displayName?: string };
      }>;
    };

    const post = data.posts?.[0];
    if (!post) return null;

    return {
      authorName: post.author.displayName || post.author.handle,
      authorHandle: post.author.handle,
    };
  } catch {
    return null;
  }
}

async function fetchMastodonParent(
  parentUri: string,
  sourceId: string,
): Promise<{
  parent: ParentItem;
  grandparentTag: { authorName: string; authorHandle: string } | null;
} | null> {
  const statusId = extractMastodonStatusId(parentUri);
  if (!statusId) return null;

  try {
    const host = new URL(parentUri).hostname;
    const res = await safeFetch(`https://${host}/api/v1/statuses/${statusId}`, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const status = JSON.parse(res.text) as {
      id: string;
      url: string;
      uri: string;
      content: string;
      created_at: string;
      account: {
        acct: string;
        display_name: string;
        avatar: string;
        url: string;
      };
      favourites_count?: number;
      replies_count?: number;
      reblogs_count?: number;
      in_reply_to_id: string | null;
      in_reply_to_account_id: string | null;
      media_attachments?: Array<{
        type: string;
        url: string;
        preview_url?: string;
        description?: string;
      }>;
    };

    const publishedAt = Math.floor(
      new Date(status.created_at).getTime() / 1000,
    );

    const media = (status.media_attachments ?? []).map((m) => ({
      type:
        m.type === "image" ? "image" : m.type === "video" ? "video" : "link",
      url: m.url,
      thumbnail: m.preview_url,
      alt: m.description,
    }));

    // Store in DB as context-only
    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_html, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'post', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count
      RETURNING id`,
      [
        sourceId,
        "activitypub",
        status.url || parentUri,
        status.account.display_name || status.account.acct,
        status.account.acct,
        status.account.avatar ?? null,
        status.account.url,
        status.content,
        JSON.stringify(media),
        null, // source_reply_uri for the parent (we know it has one if in_reply_to_id exists but we don't have the URI)
        JSON.stringify({ id: status.uri, webUrl: status.url }),
        status.favourites_count ?? 0,
        status.replies_count ?? 0,
        status.reblogs_count ?? 0,
        new Date(status.created_at),
      ],
    );

    const parent: ParentItem = {
      id: insertResult.rows[0].id,
      sourceProtocol: "activitypub",
      sourceItemUri: status.url || parentUri,
      authorName: status.account.display_name || status.account.acct,
      authorHandle: status.account.acct,
      authorAvatarUrl: status.account.avatar ?? null,
      authorUri: status.account.url,
      contentText: null,
      contentHtml: status.content,
      title: null,
      summary: null,
      likeCount: status.favourites_count ?? 0,
      replyCount: status.replies_count ?? 0,
      repostCount: status.reblogs_count ?? 0,
      media,
      publishedAt: publishedAt,
      sourceReplyUri: null,
    };

    // Grandparent tag — if in_reply_to_account_id exists, fetch account name
    let grandparentTag: {
      authorName: string;
      authorHandle: string;
    } | null = null;
    if (status.in_reply_to_id) {
      const gpTag = await fetchMastodonGrandparentTag(
        host,
        status.in_reply_to_id,
      );
      if (gpTag) grandparentTag = gpTag;
    }

    return { parent, grandparentTag };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), parentUri },
      "Mastodon parent fetch failed",
    );
    return null;
  }
}

async function fetchMastodonGrandparentTag(
  host: string,
  statusId: string,
): Promise<{ authorName: string; authorHandle: string } | null> {
  try {
    const res = await safeFetch(`https://${host}/api/v1/statuses/${statusId}`, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const status = JSON.parse(res.text) as {
      account: { acct: string; display_name: string };
    };

    return {
      authorName: status.account.display_name || status.account.acct,
      authorHandle: status.account.acct,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bluesky thread fetch
// ---------------------------------------------------------------------------

interface BlueskyThreadViewPost {
  $type?: string;
  post: {
    uri: string;
    cid: string;
    author: { did: string; handle: string; displayName?: string };
    record: {
      text?: string;
      createdAt?: string;
      reply?: { parent: { uri: string }; root: { uri: string } };
    };
    likeCount?: number;
    replyCount?: number;
    repostCount?: number;
  };
  parent?: BlueskyThreadViewPost | { $type: string };
  replies?: Array<BlueskyThreadViewPost | { $type: string }>;
}

function isThreadViewPost(
  node: BlueskyThreadViewPost | { $type: string },
): node is BlueskyThreadViewPost {
  return (
    !("$type" in node) || node.$type === "app.bsky.feed.defs#threadViewPost"
  );
}

function blueskyPostToEntry(tvp: BlueskyThreadViewPost): ExternalThreadEntry {
  const post = tvp.post;
  return {
    id: post.uri,
    authorName: post.author.displayName || post.author.handle,
    authorHandle: post.author.handle,
    authorUri: `https://bsky.app/profile/${post.author.did}`,
    contentHtml: "",
    contentText: post.record.text ?? "",
    publishedAt: post.record.createdAt ?? new Date().toISOString(),
    likeCount: post.likeCount ?? 0,
    replyCount: post.replyCount ?? 0,
    repostCount: post.repostCount ?? 0,
    parentId: post.record.reply?.parent.uri ?? null,
    protocol: "atproto",
  };
}

async function fetchBlueskyThread(
  item: ExternalItemRow,
): Promise<ThreadResponse | null> {
  try {
    const atUri =
      (item.interaction_data as { uri?: string }).uri ?? item.source_item_uri;

    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPostThread`);
    url.searchParams.append("uri", atUri);
    url.searchParams.append("depth", "50");
    url.searchParams.append("parentHeight", "100");

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as { thread: BlueskyThreadViewPost };
    if (!isThreadViewPost(data.thread)) return null;

    const focusUri = data.thread.post.uri;

    // Walk ancestors
    const ancestors: ExternalThreadEntry[] = [];
    let current = data.thread.parent;
    while (current && isThreadViewPost(current)) {
      ancestors.unshift(blueskyPostToEntry(current));
      current = current.parent;
    }

    // Flatten descendants (BFS)
    const descendants: ExternalThreadEntry[] = [];
    const queue: BlueskyThreadViewPost[] = [];
    for (const r of data.thread.replies ?? []) {
      if (isThreadViewPost(r)) queue.push(r);
    }
    while (queue.length > 0) {
      const node = queue.shift()!;
      descendants.push(blueskyPostToEntry(node));
      for (const r of node.replies ?? []) {
        if (isThreadViewPost(r)) queue.push(r);
      }
    }

    // Sort descendants chronologically
    descendants.sort(
      (a, b) =>
        new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime(),
    );

    return { ancestors, descendants };
  } catch (err) {
    logger.debug(
      {
        err: err instanceof Error ? err.message : String(err),
        uri: item.source_item_uri,
      },
      "Bluesky thread fetch failed",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mastodon thread fetch
// ---------------------------------------------------------------------------

async function fetchMastodonThread(
  item: ExternalItemRow,
): Promise<ThreadResponse | null> {
  const statusId = extractMastodonStatusId(item.source_item_uri);
  if (!statusId) return null;

  try {
    const host = new URL(item.source_item_uri).hostname;
    const res = await safeFetch(
      `https://${host}/api/v1/statuses/${statusId}/context`,
      { headers: { Accept: "application/json" } },
    );

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as {
      ancestors: MastodonStatus[];
      descendants: MastodonStatus[];
    };

    const mapStatus = (s: MastodonStatus): ExternalThreadEntry => ({
      id: s.id,
      authorName: s.account.display_name || s.account.acct,
      authorHandle: s.account.acct,
      authorUri: s.account.url,
      contentHtml: s.content ?? "",
      contentText: stripHtmlTags(s.content ?? ""),
      publishedAt: s.created_at,
      likeCount: s.favourites_count ?? 0,
      replyCount: s.replies_count ?? 0,
      repostCount: s.reblogs_count ?? 0,
      parentId: s.in_reply_to_id,
      protocol: "activitypub",
    });

    return {
      ancestors: data.ancestors.map(mapStatus),
      descendants: data.descendants.map(mapStatus),
    };
  } catch (err) {
    logger.debug(
      {
        err: err instanceof Error ? err.message : String(err),
        uri: item.source_item_uri,
      },
      "Mastodon thread fetch failed",
    );
    return null;
  }
}

interface MastodonStatus {
  id: string;
  url: string;
  uri: string;
  content: string;
  created_at: string;
  account: {
    acct: string;
    display_name: string;
    url: string;
  };
  favourites_count?: number;
  replies_count?: number;
  reblogs_count?: number;
  in_reply_to_id: string | null;
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToParentItem(row: any): ParentItem {
  return {
    id: row.id,
    sourceProtocol: row.protocol,
    sourceItemUri: row.source_item_uri,
    authorName: row.author_name,
    authorHandle: row.author_handle,
    authorAvatarUrl: row.author_avatar_url,
    authorUri: row.author_uri,
    contentText: row.content_text,
    contentHtml: row.content_html,
    title: row.title,
    summary: row.summary,
    likeCount: row.like_count ?? 0,
    replyCount: row.reply_count ?? 0,
    repostCount: row.repost_count ?? 0,
    media: row.media ?? [],
    publishedAt: Number(row.published_at_epoch),
    sourceReplyUri: row.source_reply_uri,
  };
}

function extractGrandparentTag(
  row: any,
): { authorName: string; authorHandle: string } | null {
  if (!row.source_reply_uri) return null;
  // If we have the parent's interaction_data with grandparent info, use it
  // Otherwise, return null — grandparent tag is best-effort
  return null;
}

function extractMastodonStatusId(uri: string): string | null {
  try {
    const parts = new URL(uri).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /^\d+$/.test(last)) return last;
    return null;
  } catch {
    return null;
  }
}
