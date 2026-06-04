import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import { sanitizeContent } from "@platform-pub/shared/lib/sanitize.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import { requireAuth } from "../middleware/auth.js";
import {
  enqueueCrossPost,
  enqueueLike,
  enqueueRepost,
  enqueuePollVote,
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

const quoteCache = new Map<
  string,
  { data: QuoteResponse; expiresAt: number }
>();
const QUOTE_CACHE_TTL_MS = 120_000;

const threadCache = new Map<
  string,
  { data: ThreadResponse; expiresAt: number }
>();
const THREAD_CACHE_TTL_MS = 60_000;

// All four caches above use a TTL but never sweep, so over a long-lived process
// their keyspace grows monotonically: the thread cache key embeds the
// attacker-controlled `focus` param (a distinct entry per value), and the
// id-keyed caches accumulate one permanent entry per external item ever viewed.
// `setCapped` bounds every cache to CACHE_MAX_ENTRIES, sweeping expired entries
// first and then evicting oldest insertions (Map iterates insertion order).
const CACHE_MAX_ENTRIES = 1000;

function setCapped<V extends { expiresAt: number }>(
  cache: Map<string, V>,
  key: string,
  value: V,
): void {
  cache.set(key, value);
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (cache.size <= CACHE_MAX_ENTRIES) break;
    if (v.expiresAt <= now) cache.delete(k);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Outbound source fetches for the essential neighbourhood data (parent, quote,
// thread) cap at 8s per CARD-BEHAVIOUR-ADR §VII.3 — tighter than the shared
// client's 10s default so a slow source platform can't hold a hydration request
// open, but with enough headroom for a cold fetch (every call builds a fresh
// SSRF-pinned agent, so each pays a full DNS+TLS handshake with no pooling).
const NEIGHBOURHOOD_FETCH_TIMEOUT_MS = 8_000;

// The grandparent author tag is optional sugar ("→ in reply to X") and is also
// populated independently by the external_parent_prefetch worker. It is awaited
// on the parent fetch's critical path, so it gets a much tighter budget: a slow
// grandparent must never extend or jeopardise the parent response, and /parent
// must not balloon toward two full primary timeouts.
const GRANDPARENT_FETCH_TIMEOUT_MS = 2_500;

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
  // The re-rooted focal node rendered as a full card (author + content + its own
  // media + engagement counts), persisted context-only so it carries a real
  // all.haus id the client can like/repost/reply against. Populated ONLY when the
  // request carries `?focus=` (re-rooting onto a reply/ancestor) — for the base
  // item the client already renders the host richly. null when the focus node's
  // source fetch failed. See CARD-BEHAVIOUR-ADR addendum (rich re-rooted focal).
  focus?: ParentItem | null;
  // Server-signalled (CARD-BEHAVIOUR-ADR §VII.3): true when the source thread
  // could not be reached or completed (fetch failure / timeout). The client no
  // longer infers this from a rejected promise.
  partial: boolean;
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
  // Server-signalled (CARD-BEHAVIOUR-ADR §VII.3): true when a parent was
  // expected (the item is a reply) but the source fetch failed / timed out.
  partial: boolean;
}

interface QuoteResponse {
  // A quoted post is rendered as a nested mini-card; it carries the same shape
  // as a parent (author + content + its own media). null when the item quotes
  // nothing, or when the source fetch couldn't produce the quoted post.
  quote: ParentItem | null;
  // Server-signalled (CARD-BEHAVIOUR-ADR §VII.3): true when a quote was expected
  // (source_quote_uri is set) but the source fetch failed / timed out.
  partial: boolean;
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
  source_quote_uri?: string | null;
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

      setCapped(engagementCache, id, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );

  // =========================================================================
  // GET /external-items/:id/parent — parent context tile for reply items
  // =========================================================================
  app.get<{ Params: { id: string } }>(
    "/external-items/:id/parent",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
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
          partial: false,
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
      // A parent is expected (source_reply_uri is set); if the source fetch
      // can't produce it, the neighbourhood is partial.
      let partial = false;

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
        } else {
          partial = true;
        }
      }

      const data: ParentContextResponse = { parent, grandparentTag, partial };
      setCapped(parentCache, id, {
        data,
        expiresAt: Date.now() + PARENT_CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );

  // =========================================================================
  // GET /external-items/:id/quote — quoted-post tile for quote posts.
  // Mirrors /parent: a quoted post is hydrated (from external_items if already
  // present, else fetched from the source platform) and rendered as a nested
  // mini-card in our idiom. Same rate-limit / cache / partial-flag contract.
  // =========================================================================
  app.get<{ Params: { id: string } }>(
    "/external-items/:id/quote",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { id } = req.params;

      const cached = quoteCache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      const { rows } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_quote_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }

      const item = rows[0];

      if (!item.source_quote_uri) {
        const data: QuoteResponse = { quote: null, partial: false };
        return reply.send(data);
      }

      // Already hydrated? (e.g. eager prefetch, or the quoted post is itself a
      // subscribed item).
      const { rows: quoteRows } = await pool.query(
        `SELECT id, protocol, source_item_uri, source_reply_uri,
                author_name, author_handle, author_avatar_url, author_uri,
                content_text, content_html, title, summary, media,
                like_count, reply_count, repost_count, interaction_data,
                EXTRACT(EPOCH FROM published_at)::bigint AS published_at_epoch
         FROM external_items
         WHERE source_item_uri = $1 AND protocol = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [item.source_quote_uri, item.protocol],
      );

      let quote: ParentItem | null = null;
      let partial = false;

      if (quoteRows.length > 0) {
        quote = rowToParentItem(quoteRows[0]);
      } else {
        const fetched = await fetchQuoteFromSource(item);
        if (fetched) {
          quote = fetched;
        } else {
          partial = true;
        }
      }

      // Make the quoted post resolvable as a re-root target (best-effort: a
      // failure here only means re-root falls back to a no-op, never a 500).
      if (quote) {
        await ensureQuoteFeedItem(quote.id).catch(() => {});
      }

      const data: QuoteResponse = { quote, partial };
      setCapped(quoteCache, id, {
        data,
        expiresAt: Date.now() + QUOTE_CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );

  // =========================================================================
  // GET /external-items/:id/thread — full reply thread from source platform
  // =========================================================================
  app.get<{ Params: { id: string }; Querystring: { focus?: string } }>(
    "/external-items/:id/thread",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { id } = req.params;
      // `focus` re-roots the thread on a source-platform node (a clicked
      // ancestor/descendant whose ExternalThreadEntry.id is a source URI/id, not
      // an all.haus id). The base item row scopes protocol + host, so there is
      // no SSRF surface (see deriveFocusItem). NOTE: for atproto, `focus` is an
      // at:// URI that is NOT verified to belong to the base item's
      // conversation — this is effectively an authed read-proxy for any public
      // Bluesky thread on the pinned AppView host. Acceptable (the data is
      // already public) but it is not "ownership scoping" (L6).
      const focus = req.query.focus?.trim() || null;

      const cacheKey = focus ? `${id}|${focus}` : id;
      const cached = threadCache.get(cacheKey);
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

      const item = focus ? deriveFocusItem(rows[0], focus) : rows[0];
      // When re-rooting, also hydrate the focal node itself as a full card (the
      // base-item case renders the host richly client-side, so it's skipped).
      const wantFocus = !!focus;
      let data: ThreadResponse = {
        ancestors: [],
        descendants: [],
        partial: false,
      };

      if (item.protocol === "atproto") {
        const thread = await fetchBlueskyThread(item, wantFocus);
        // null = source unreachable / timed out → partial; nostr_external + rss
        // intentionally return an empty (non-partial) thread.
        if (thread) data = thread;
        else data = { ancestors: [], descendants: [], partial: true };
      } else if (item.protocol === "activitypub") {
        const thread = await fetchMastodonThread(item, wantFocus);
        if (thread) data = thread;
        else data = { ancestors: [], descendants: [], partial: true };
      }

      setCapped(threadCache, cacheKey, {
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
      const accountId = req.session!.sub;

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
      const accountId = req.session!.sub;

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
  // POST /external-items/:id/poll-vote — vote on Mastodon poll
  // =========================================================================
  app.post<{
    Params: { id: string };
    Body: { linkedAccountId: string; choices: number[] };
  }>(
    "/external-items/:id/poll-vote",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;
      const { linkedAccountId, choices } = req.body ?? {};
      const accountId = req.session!.sub;

      if (!linkedAccountId) {
        return reply.status(400).send({ error: "linkedAccountId is required" });
      }
      if (!Array.isArray(choices) || choices.length === 0) {
        return reply.status(400).send({ error: "choices array is required" });
      }

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

      if (item.protocol !== "activitypub") {
        return reply
          .status(422)
          .send({ error: "Poll voting is only supported for Mastodon items" });
      }

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
      if (la[0].protocol !== "activitypub") {
        return reply.status(422).send({
          error: "Linked account must be a Mastodon account",
        });
      }

      try {
        await enqueuePollVote({
          accountId,
          linkedAccountId,
          sourceItemId: id,
          choices,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err: msg, itemId: id, accountId },
          "Poll vote enqueue failed",
        );
        return reply.status(500).send({ error: "Failed to enqueue poll vote" });
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
      const accountId = req.session!.sub;

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
      timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
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

    let grandparentTag: {
      authorName: string;
      authorHandle: string;
    } | null = null;
    if (parentReplyUri) {
      const gpTag = await fetchBlueskyGrandparentTag(parentReplyUri);
      if (gpTag) grandparentTag = gpTag;
    }

    const interactionData: Record<string, unknown> = {
      uri: post.uri,
      cid: post.cid,
    };
    if (grandparentTag) interactionData.grandparent = grandparentTag;

    // Store in DB as context-only
    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_text, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'tier3', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        interaction_data = EXCLUDED.interaction_data
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
        JSON.stringify(interactionData),
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
      timeout: GRANDPARENT_FETCH_TIMEOUT_MS,
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
      timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
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

    const interactionData: Record<string, unknown> = {
      id: status.uri,
      webUrl: status.url,
    };
    if (grandparentTag) interactionData.grandparent = grandparentTag;

    // Store in DB as context-only
    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_html, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'tier3', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        interaction_data = EXCLUDED.interaction_data
      RETURNING id`,
      [
        sourceId,
        "activitypub",
        status.url || parentUri,
        status.account.display_name || status.account.acct,
        status.account.acct,
        status.account.avatar ?? null,
        status.account.url,
        sanitizeContent(status.content),
        JSON.stringify(media),
        null,
        JSON.stringify(interactionData),
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
      contentHtml: sanitizeContent(status.content),
      title: null,
      summary: null,
      likeCount: status.favourites_count ?? 0,
      replyCount: status.replies_count ?? 0,
      repostCount: status.reblogs_count ?? 0,
      media,
      publishedAt: publishedAt,
      sourceReplyUri: null,
    };

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
      timeout: GRANDPARENT_FETCH_TIMEOUT_MS,
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
// Quote-post fetch from source platform (mirrors the parent-context fetch)
// ---------------------------------------------------------------------------

interface QuoteMedia {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  title?: string;
  description?: string;
}

// Mastodon's OpenGraph link preview (a `card` on the status — never in the AP
// outbox) becomes the same {type:"link"} media entry we render for Bluesky's
// app.bsky.embed.external, so a previewed link looks identical across sources.
function mastodonCardToMedia(
  card:
    | {
        url?: string;
        title?: string;
        description?: string;
        image?: string | null;
        type?: string;
      }
    | null
    | undefined,
): QuoteMedia | null {
  if (!card?.url) return null;
  if (card.type && card.type !== "link") return null;
  return {
    type: "link",
    url: card.url,
    thumbnail: card.image ?? undefined,
    title: card.title || undefined,
    description: card.description || undefined,
  };
}

// Bluesky hydrated (#view) embeds carry full CDN URLs already. Extract media
// from the quoted post's own embed; recordWithMedia carries media alongside the
// nested record, which we deliberately do not recurse into (no quote-of-quote).
function extractBlueskyViewMedia(embed: unknown): QuoteMedia[] {
  const out: QuoteMedia[] = [];
  const handle = (v: any) => {
    const t: string | undefined = v?.$type;
    if (!t) return;
    if (t.startsWith("app.bsky.embed.images") && Array.isArray(v.images)) {
      for (const img of v.images) {
        if (img.fullsize)
          out.push({
            type: "image",
            url: img.fullsize,
            thumbnail: img.thumb,
            alt: img.alt || undefined,
          });
      }
    } else if (t.startsWith("app.bsky.embed.external") && v.external?.uri) {
      out.push({
        type: "link",
        url: v.external.uri,
        thumbnail: v.external.thumb,
        title: v.external.title || undefined,
        description: v.external.description || undefined,
      });
    } else if (t.startsWith("app.bsky.embed.video") && v.playlist) {
      out.push({ type: "video", url: v.playlist, thumbnail: v.thumbnail });
    }
  };
  const e = embed as any;
  if (e?.$type?.startsWith("app.bsky.embed.recordWithMedia") && e.media) {
    handle(e.media);
  } else {
    handle(e);
  }
  return out;
}

// Pull the quoted post's at:// URI out of a Bluesky hydrated (#view) embed.
// record#view nests the quoted post at e.record.uri; recordWithMedia#view wraps
// a record#view at e.record.record.uri. (recordWithMedia is checked first — its
// $type also starts with "app.bsky.embed.record".) Mirrors the adapter's
// ingest-time extraction so a quote learned via thread hydration keys the same
// source_quote_uri the quote tile resolves from. Detached/blocked/not-found
// quoted records still carry a uri; the quote endpoint resolves it best-effort.
function extractBlueskyViewQuoteUri(embed: unknown): string | null {
  const e = embed as any;
  const t: string | undefined = e?.$type;
  if (!t) return null;
  if (t.startsWith("app.bsky.embed.recordWithMedia")) {
    const uri = e.record?.record?.uri;
    return typeof uri === "string" ? uri : null;
  }
  if (t.startsWith("app.bsky.embed.record")) {
    const uri = e.record?.uri;
    return typeof uri === "string" ? uri : null;
  }
  return null;
}

// Re-root target enablement: give a quoted post a context-only feed_items row so
// GET /thread/:postId can resolve it when the reader clicks the quote tile to
// re-root onto it. The thread projector resolves an external focal via
// `feed_items WHERE post_id = $1`; a quote inserted into external_items alone
// (the on-demand fetch + the prefetch worker both write external_items only)
// has no post_id until the daily feed_items_reconcile backfills it, so re-root
// would 404 until then. This mirrors reconcile case 3 for a single row, runs at
// the moment the tile is displayed (the only time re-root is reachable), and is
// idempotent. The feed query filters is_context_only, so it never surfaces in
// the timeline. The identity trigger mints post_id from (protocol,
// source_item_uri) — identical to the host's source_quote_uri derivation — so
// the minted post_id equals the host Post's `quotes`, which is the re-root id.
async function ensureQuoteFeedItem(externalItemId: string): Promise<void> {
  await pool.query(
    `INSERT INTO feed_items (
       item_type, external_item_id,
       author_name, author_avatar,
       title, content_preview,
       tier, published_at,
       source_protocol, source_item_uri, source_id, media,
       is_reply
     )
     SELECT
       'external', ei.id,
       COALESCE(ei.author_name, xs.display_name, 'Unknown'),
       COALESCE(ei.author_avatar_url, xs.avatar_url),
       ei.title,
       LEFT(COALESCE(ei.content_text, ei.summary), 200),
       ei.tier, ei.published_at,
       ei.protocol::text, ei.source_item_uri, ei.source_id, ei.media,
       ei.source_reply_uri IS NOT NULL
     FROM external_items ei
     JOIN external_sources xs ON xs.id = ei.source_id
     WHERE ei.id = $1 AND ei.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.external_item_id = ei.id)
     ON CONFLICT DO NOTHING`,
    [externalItemId],
  );
}

async function fetchQuoteFromSource(
  item: ExternalItemRow,
): Promise<ParentItem | null> {
  const quoteUri = item.source_quote_uri!;
  if (item.protocol === "atproto") {
    return fetchBlueskyQuote(quoteUri, item.source_id);
  }
  if (item.protocol === "activitypub") {
    return fetchMastodonQuote(quoteUri, item.source_id);
  }
  return null;
}

async function fetchBlueskyQuote(
  quoteUri: string,
  sourceId: string,
): Promise<ParentItem | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", quoteUri);

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
      timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
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
        record: { text?: string; createdAt?: string };
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
    const media = extractBlueskyViewMedia(post.embed);

    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_text, media, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'tier3', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        media = EXCLUDED.media
      RETURNING id`,
      [
        sourceId,
        "atproto",
        quoteUri,
        post.author.displayName || post.author.handle,
        post.author.handle,
        post.author.avatar ?? null,
        `https://bsky.app/profile/${post.author.did}`,
        post.record.text ?? null,
        JSON.stringify(media),
        JSON.stringify({ uri: post.uri, cid: post.cid }),
        post.likeCount ?? 0,
        post.replyCount ?? 0,
        post.repostCount ?? 0,
        new Date(post.record.createdAt ?? Date.now()),
      ],
    );

    return {
      id: insertResult.rows[0].id,
      sourceProtocol: "atproto",
      sourceItemUri: quoteUri,
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
      media,
      publishedAt,
      sourceReplyUri: null,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), quoteUri },
      "Bluesky quote fetch failed",
    );
    return null;
  }
}

async function fetchMastodonQuote(
  quoteUri: string,
  sourceId: string,
): Promise<ParentItem | null> {
  const statusId = extractMastodonStatusId(quoteUri);
  if (!statusId) return null;

  try {
    const host = new URL(quoteUri).hostname;
    const res = await safeFetch(`https://${host}/api/v1/statuses/${statusId}`, {
      headers: { Accept: "application/json" },
      timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
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
      media_attachments?: Array<{
        type: string;
        url: string;
        preview_url?: string;
        description?: string;
      }>;
      card?: {
        url?: string;
        title?: string;
        description?: string;
        image?: string | null;
        type?: string;
      } | null;
    };

    const publishedAt = Math.floor(
      new Date(status.created_at).getTime() / 1000,
    );

    const media: QuoteMedia[] = (status.media_attachments ?? []).map((m) => ({
      type: (m.type === "image"
        ? "image"
        : m.type === "video"
          ? "video"
          : "link") as QuoteMedia["type"],
      url: m.url,
      thumbnail: m.preview_url,
      alt: m.description,
    }));
    const link = mastodonCardToMedia(status.card);
    if (link) media.push(link);

    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_html, media, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'tier3', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        media = EXCLUDED.media
      RETURNING id`,
      [
        sourceId,
        "activitypub",
        status.url || quoteUri,
        status.account.display_name || status.account.acct,
        status.account.acct,
        status.account.avatar ?? null,
        status.account.url,
        sanitizeContent(status.content),
        JSON.stringify(media),
        JSON.stringify({ id: status.uri, webUrl: status.url }),
        status.favourites_count ?? 0,
        status.replies_count ?? 0,
        status.reblogs_count ?? 0,
        new Date(status.created_at),
      ],
    );

    return {
      id: insertResult.rows[0].id,
      sourceProtocol: "activitypub",
      sourceItemUri: status.url || quoteUri,
      authorName: status.account.display_name || status.account.acct,
      authorHandle: status.account.acct,
      authorAvatarUrl: status.account.avatar ?? null,
      authorUri: status.account.url,
      contentText: null,
      contentHtml: sanitizeContent(status.content),
      title: null,
      summary: null,
      likeCount: status.favourites_count ?? 0,
      replyCount: status.replies_count ?? 0,
      repostCount: status.reblogs_count ?? 0,
      media,
      publishedAt,
      sourceReplyUri: null,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), quoteUri },
      "Mastodon quote fetch failed",
    );
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
    author: { did: string; handle: string; displayName?: string; avatar?: string };
    record: {
      text?: string;
      createdAt?: string;
      reply?: { parent: { uri: string }; root: { uri: string } };
    };
    // Hydrated view embed (#view) — carries full CDN media URLs. Only read when
    // building the rich focus node (extractBlueskyViewMedia).
    embed?: unknown;
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

// Hydrate a Bluesky thread-root post into a rich focal ParentItem and persist it
// context-only (so like/repost/reply have a real all.haus id to act on). Mirrors
// fetchBlueskyParent's upsert. Returns null on persist failure (caller degrades).
async function persistBlueskyFocus(
  post: BlueskyThreadViewPost["post"],
  sourceId: string,
): Promise<ParentItem | null> {
  try {
    const media = extractBlueskyViewMedia(post.embed);
    const authorName = post.author.displayName || post.author.handle;
    const authorUri = `https://bsky.app/profile/${post.author.did}`;
    const parentReplyUri = post.record.reply?.parent.uri ?? null;
    const publishedAt = Math.floor(
      new Date(post.record.createdAt ?? Date.now()).getTime() / 1000,
    );
    const ins = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_text, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, 'atproto', 'tier3', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        interaction_data = EXCLUDED.interaction_data
      RETURNING id`,
      [
        sourceId,
        post.uri,
        authorName,
        post.author.handle,
        post.author.avatar ?? null,
        authorUri,
        post.record.text ?? null,
        JSON.stringify(media),
        parentReplyUri,
        JSON.stringify({ uri: post.uri, cid: post.cid }),
        post.likeCount ?? 0,
        post.replyCount ?? 0,
        post.repostCount ?? 0,
        new Date(post.record.createdAt ?? Date.now()),
      ],
    );

    return {
      id: ins.rows[0].id,
      sourceProtocol: "atproto",
      sourceItemUri: post.uri,
      authorName,
      authorHandle: post.author.handle,
      authorAvatarUrl: post.author.avatar ?? null,
      authorUri,
      contentText: post.record.text ?? null,
      contentHtml: null,
      title: null,
      summary: null,
      likeCount: post.likeCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
      media,
      publishedAt,
      sourceReplyUri: parentReplyUri,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), uri: post.uri },
      "Bluesky focus persist failed",
    );
    return null;
  }
}

async function fetchBlueskyThread(
  item: ExternalItemRow,
  wantFocus = false,
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
      timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as { thread: BlueskyThreadViewPost };
    if (!isThreadViewPost(data.thread)) return null;

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

    // The thread root IS the focused node; when re-rooting, hydrate it as a rich
    // focal card (media from its #view embed) and persist context-only so it gets
    // a real id for like/repost/reply. Best-effort: a persist failure leaves
    // focus null and the client falls back to the lightweight focal it already has.
    let focus: ParentItem | null = null;
    if (wantFocus) {
      focus = await persistBlueskyFocus(data.thread.post, item.source_id);
    }

    return { ancestors, descendants, focus, partial: false };
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
  wantFocus = false,
): Promise<ThreadResponse | null> {
  const statusId = extractMastodonStatusId(item.source_item_uri);
  if (!statusId) return null;

  try {
    const host = new URL(item.source_item_uri).hostname;
    const res = await safeFetch(
      `https://${host}/api/v1/statuses/${statusId}/context`,
      {
        headers: { Accept: "application/json" },
        timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
      },
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
      contentHtml: sanitizeContent(s.content ?? ""),
      contentText: stripHtmlTags(s.content ?? ""),
      publishedAt: s.created_at,
      likeCount: s.favourites_count ?? 0,
      replyCount: s.replies_count ?? 0,
      repostCount: s.reblogs_count ?? 0,
      parentId: s.in_reply_to_id,
      protocol: "activitypub",
    });

    // The /context endpoint omits the focal status itself; when re-rooting,
    // fetch it directly and persist context-only so it renders as a rich focal
    // card with a real id (best-effort — null degrades to lightweight focal).
    let focus: ParentItem | null = null;
    if (wantFocus) {
      focus = await persistMastodonFocus(host, statusId, item.source_id);
    }

    return {
      ancestors: data.ancestors.map(mapStatus),
      descendants: data.descendants.map(mapStatus),
      focus,
      partial: false,
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

// Fetch a single Mastodon status (the re-rooted focal — /context omits it) and
// persist it context-only so it renders as a rich focal card with a real id.
// Mirrors fetchMastodonParent's upsert. Returns null on fetch/persist failure.
async function persistMastodonFocus(
  host: string,
  statusId: string,
  sourceId: string,
): Promise<ParentItem | null> {
  try {
    const res = await safeFetch(
      `https://${host}/api/v1/statuses/${statusId}`,
      {
        headers: { Accept: "application/json" },
        timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
      },
    );
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
      media_attachments?: Array<{
        type: string;
        url: string;
        preview_url?: string;
        description?: string;
      }>;
    };

    const authorName = status.account.display_name || status.account.acct;
    const media = (status.media_attachments ?? []).map((m) => ({
      type:
        m.type === "image" ? "image" : m.type === "video" ? "video" : "link",
      url: m.url,
      thumbnail: m.preview_url,
      alt: m.description,
    }));
    const contentHtml = sanitizeContent(status.content ?? "");
    const publishedAt = Math.floor(
      new Date(status.created_at).getTime() / 1000,
    );

    const ins = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_html, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, 'activitypub', 'tier3', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        interaction_data = EXCLUDED.interaction_data
      RETURNING id`,
      [
        sourceId,
        status.url || status.uri,
        authorName,
        status.account.acct,
        status.account.avatar ?? null,
        status.account.url,
        contentHtml,
        JSON.stringify(media),
        null,
        JSON.stringify({ id: status.uri, webUrl: status.url }),
        status.favourites_count ?? 0,
        status.replies_count ?? 0,
        status.reblogs_count ?? 0,
        new Date(status.created_at),
      ],
    );

    return {
      id: ins.rows[0].id,
      sourceProtocol: "activitypub",
      sourceItemUri: status.url || status.uri,
      authorName,
      authorHandle: status.account.acct,
      authorAvatarUrl: status.account.avatar ?? null,
      authorUri: status.account.url,
      contentText: stripHtmlTags(status.content ?? ""),
      contentHtml,
      title: null,
      summary: null,
      likeCount: status.favourites_count ?? 0,
      replyCount: status.replies_count ?? 0,
      repostCount: status.reblogs_count ?? 0,
      media,
      publishedAt,
      sourceReplyUri: null,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), statusId },
      "Mastodon focus persist failed",
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

// ===========================================================================
// Live thread hydration → DB (UNIVERSAL-POST-ADR §8, /thread parity fix)
//
// The unified /thread projector (post-thread.ts) is pure-DB: it walks
// source_reply_uri over INGESTED external_items. But we ingest only a source's
// own posts, not the full reply graph around them — so a Bluesky/Mastodon item
// that advertises N replies on-origin would expand to nothing. The legacy
// /external-items/:id/thread papered over this with a LIVE source-API walk that
// rendered transient entries; the Phase-5 cutover dropped that path.
//
// This restores parity by HYDRATING the live source thread into the substrate
// the projector reads: each ancestor/descendant is persisted context-only into
// external_items + feed_items (the identity trigger mints post_id / version /
// biddability_tier / external_author_id), so /thread then resolves them exactly
// like natively-ingested nodes. is_context_only keeps them out of the main feed
// (post-feed.ts / timeline.ts filter on it); external-context-gc reclaims them.
//
// Best-effort and throttled: a per-item TTL guard prevents a re-write storm on
// repeated expands, and any source/DB failure leaves the request to fall back to
// whatever was already ingested.
// ===========================================================================

interface HydratedNode {
  sourceItemUri: string;
  sourceReplyUri: string | null;
  sourceQuoteUri: string | null;
  authorName: string;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  media: unknown[];
  interactionData: Record<string, unknown>;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  publishedAt: Date;
}

// Throttle: skip the live fetch + re-write when we hydrated this item recently.
const hydrateGuard = new Map<string, number>();
const HYDRATE_TTL_MS = 60_000;

// Dual-write a batch of hydrated nodes (external_items + feed_items) in one
// transaction. Context-only; deduped by (protocol, source_item_uri) so a node
// already ingested for real is left as a counts refresh, never duplicated.
async function persistHydratedThreadNodes(
  sourceId: string,
  protocol: "atproto" | "activitypub",
  nodes: HydratedNode[],
): Promise<void> {
  if (nodes.length === 0) return;
  // atproto + activitypub both map to content_tier 'tier3' (migration 099 §7).
  const tier = "tier3";
  await withTransaction(async (client) => {
    for (const n of nodes) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO external_items (
           source_id, protocol, tier, source_item_uri,
           author_name, author_handle, author_avatar_url, author_uri,
           content_text, content_html, media,
           source_reply_uri, interaction_data,
           like_count, reply_count, repost_count,
           published_at, source_quote_uri, is_context_only
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, TRUE)
         ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
           like_count = EXCLUDED.like_count,
           reply_count = EXCLUDED.reply_count,
           repost_count = EXCLUDED.repost_count,
           interaction_data = EXCLUDED.interaction_data,
           -- Fill the parent linkage when we didn't already have it. The ancestor
           -- walk (assembleExternalThread → loadExternalByUri) climbs via
           -- source_reply_uri; a row first seen as a standalone feed item has a
           -- NULL link, so hydration is the only place it can be learned. COALESCE
           -- so a context-only hydrate only *fills* a gap, never clobbers an
           -- authoritative ingested linkage.
           source_reply_uri = COALESCE(external_items.source_reply_uri, EXCLUDED.source_reply_uri),
           -- Same gap-fill for the quote linkage: a row first seen as a standalone
           -- feed item (or via reply-only hydration) has a NULL quote uri, so a
           -- later thread hydration is where the quoted post is learned. COALESCE
           -- only fills, never clobbers an authoritative ingested value.
           source_quote_uri = COALESCE(external_items.source_quote_uri, EXCLUDED.source_quote_uri),
           -- Backfill body/media only when the existing copy is empty, so the
           -- thin row a standalone ingest left behind gains the richer hydrated
           -- content (parents were rendering blank), without overwriting a row
           -- that was already ingested in full.
           content_text = COALESCE(external_items.content_text, EXCLUDED.content_text),
           content_html = COALESCE(external_items.content_html, EXCLUDED.content_html),
           media = CASE
             WHEN external_items.media IS NULL
               OR jsonb_array_length(COALESCE(external_items.media, '[]'::jsonb)) = 0
             THEN EXCLUDED.media
             ELSE external_items.media
           END
         RETURNING id`,
        [
          sourceId,
          protocol,
          tier,
          n.sourceItemUri,
          n.authorName,
          n.authorHandle,
          n.authorAvatarUrl,
          n.authorUri,
          n.contentText,
          n.contentHtml,
          JSON.stringify(n.media),
          n.sourceReplyUri,
          JSON.stringify(n.interactionData),
          n.likeCount,
          n.replyCount,
          n.repostCount,
          n.publishedAt,
          n.sourceQuoteUri,
        ],
      );
      const extId = ins.rows[0]?.id;
      if (!extId) continue;
      // feed_items dual-write; the BEFORE INSERT identity trigger mints
      // post_id/version/biddability_tier/external_author_id from these columns.
      await client.query(
        `INSERT INTO feed_items (
           item_type, external_item_id,
           author_name, author_avatar,
           title, content_preview,
           tier, published_at,
           source_protocol, source_item_uri, source_id, media,
           is_reply
         ) VALUES (
           'external', $1,
           $2, $3,
           NULL, $4,
           $5, $6,
           $7, $8, $9, $10,
           $11
         )
         ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING`,
        [
          extId,
          n.authorName,
          n.authorAvatarUrl,
          truncatePreview(n.contentText ?? ""),
          tier,
          n.publishedAt,
          protocol,
          n.sourceItemUri,
          sourceId,
          JSON.stringify(n.media),
          n.sourceReplyUri != null,
        ],
      );
    }
  });
}

// Walk a Bluesky getPostThread response into hydrated nodes (parent chain +
// focal + flattened replies). Keyed by at:// URIs, which are exactly the
// (protocol, source_item_uri) the projector + identity trigger derive post_id
// from, so reply edges connect to the focal already in feed_items.
function collectBlueskyThreadNodes(
  root: BlueskyThreadViewPost,
): HydratedNode[] {
  const out: HydratedNode[] = [];
  const seen = new Set<string>();
  const add = (tvp: BlueskyThreadViewPost) => {
    const post = tvp.post;
    if (!post?.uri || seen.has(post.uri)) return;
    seen.add(post.uri);
    out.push({
      sourceItemUri: post.uri,
      sourceReplyUri: post.record.reply?.parent.uri ?? null,
      sourceQuoteUri: extractBlueskyViewQuoteUri(post.embed),
      authorName: post.author.displayName || post.author.handle,
      authorHandle: post.author.handle,
      authorAvatarUrl: post.author.avatar ?? null,
      authorUri: `https://bsky.app/profile/${post.author.did}`,
      contentText: post.record.text ?? null,
      contentHtml: null,
      media: extractBlueskyViewMedia(post.embed),
      interactionData: { uri: post.uri, cid: post.cid },
      likeCount: post.likeCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
      publishedAt: new Date(post.record.createdAt ?? Date.now()),
    });
  };

  // ancestors (parent chain)
  let cur = root.parent;
  while (cur && isThreadViewPost(cur)) {
    add(cur);
    cur = cur.parent;
  }
  // focal + descendants (BFS)
  add(root);
  const queue: BlueskyThreadViewPost[] = [];
  for (const r of root.replies ?? []) if (isThreadViewPost(r)) queue.push(r);
  while (queue.length > 0) {
    const node = queue.shift()!;
    add(node);
    for (const r of node.replies ?? []) if (isThreadViewPost(r)) queue.push(r);
  }
  return out;
}

async function hydrateBlueskyThread(item: ExternalItemRow): Promise<void> {
  const atUri =
    (item.interaction_data as { uri?: string }).uri ?? item.source_item_uri;
  const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPostThread`);
  url.searchParams.append("uri", atUri);
  url.searchParams.append("depth", "50");
  url.searchParams.append("parentHeight", "100");

  const res = await safeFetch(url.toString(), {
    headers: { Accept: "application/json" },
    timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) return;
  const data = JSON.parse(res.text) as { thread: BlueskyThreadViewPost };
  if (!isThreadViewPost(data.thread)) return;

  await persistHydratedThreadNodes(
    item.source_id,
    "atproto",
    collectBlueskyThreadNodes(data.thread),
  );
}

async function hydrateMastodonThread(item: ExternalItemRow): Promise<void> {
  const statusId = extractMastodonStatusId(item.source_item_uri);
  if (!statusId) return;
  const host = new URL(item.source_item_uri).hostname;
  const res = await safeFetch(
    `https://${host}/api/v1/statuses/${statusId}/context`,
    { headers: { Accept: "application/json" }, timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS },
  );
  if (!res.ok) return;

  interface RichStatus extends MastodonStatus {
    account: MastodonStatus["account"] & { avatar?: string };
    media_attachments?: Array<{
      type: string;
      url: string;
      preview_url?: string;
      description?: string;
    }>;
  }
  const data = JSON.parse(res.text) as {
    ancestors: RichStatus[];
    descendants: RichStatus[];
  };

  // in_reply_to_id is a LOCAL status id, but the projector threads on
  // source_reply_uri. Map every id in the conversation (incl. the focal, whose
  // stored uri is item.source_item_uri) to the canonical uri we persist, so a
  // reply's source_reply_uri equals its parent's source_item_uri.
  // Key on the federated ActivityPub id (`uri`), NOT the human web `url`: the
  // ingestion adapter stores source_item_uri = note.id and source_reply_uri =
  // note.inReplyTo, both of which are the `uri` form. Persisting ancestors under
  // `url` would mint a parallel id-space, so the focal's source_reply_uri never
  // matches a hydrated parent's source_item_uri and the ancestor walk finds
  // nothing (parents go missing). `uri` is always present on a Mastodon status.
  const canonicalUri = (s: RichStatus) => s.uri || s.url;
  const idToUri = new Map<string, string>();
  idToUri.set(statusId, item.source_item_uri);
  for (const s of [...data.ancestors, ...data.descendants]) {
    idToUri.set(s.id, canonicalUri(s));
  }

  const toNode = (s: RichStatus): HydratedNode => ({
    sourceItemUri: canonicalUri(s),
    sourceReplyUri: s.in_reply_to_id
      ? (idToUri.get(s.in_reply_to_id) ?? null)
      : null,
    // Mastodon's status context carries no quote linkage; quotes for fedi posts
    // are resolved on demand by the quote endpoint, not via hydration.
    sourceQuoteUri: null,
    authorName: s.account.display_name || s.account.acct,
    authorHandle: s.account.acct,
    authorAvatarUrl: s.account.avatar ?? null,
    authorUri: s.account.url,
    contentText: stripHtmlTags(s.content ?? ""),
    contentHtml: sanitizeContent(s.content ?? ""),
    media: (s.media_attachments ?? []).map((m) => ({
      type: m.type === "image" ? "image" : m.type === "video" ? "video" : "link",
      url: m.url,
      thumbnail: m.preview_url,
      alt: m.description,
    })),
    interactionData: { id: s.uri, webUrl: s.url },
    likeCount: s.favourites_count ?? 0,
    replyCount: s.replies_count ?? 0,
    repostCount: s.reblogs_count ?? 0,
    publishedAt: new Date(s.created_at),
  });

  await persistHydratedThreadNodes(item.source_id, "activitypub", [
    ...data.ancestors.map(toNode),
    ...data.descendants.map(toNode),
  ]);
}

// Public entrypoint: best-effort, throttled hydration of an external item's live
// source thread into external_items + feed_items, so the pure-DB /thread
// projector can then resolve its ancestors + replies. Never throws.
export async function hydrateExternalThreadContext(item: {
  id: string;
  source_id: string;
  protocol: string;
  source_item_uri: string;
  interaction_data: Record<string, unknown> | null;
}): Promise<void> {
  if (item.protocol !== "atproto" && item.protocol !== "activitypub") return;
  const until = hydrateGuard.get(item.id);
  if (until && until > Date.now()) return;
  hydrateGuard.set(item.id, Date.now() + HYDRATE_TTL_MS);
  if (hydrateGuard.size > CACHE_MAX_ENTRIES) {
    const oldest = hydrateGuard.keys().next().value;
    if (oldest !== undefined) hydrateGuard.delete(oldest);
  }

  const row: ExternalItemRow = {
    id: item.id,
    source_id: item.source_id,
    protocol: item.protocol,
    source_item_uri: item.source_item_uri,
    source_reply_uri: null,
    like_count: 0,
    reply_count: 0,
    repost_count: 0,
    interaction_data: item.interaction_data ?? {},
  };
  try {
    if (item.protocol === "atproto") await hydrateBlueskyThread(row);
    else await hydrateMastodonThread(row);
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), id: item.id },
      "External thread hydration failed",
    );
  }
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
  const gp = row.interaction_data?.grandparent;
  if (gp?.authorName && gp?.authorHandle) return gp;
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

// Build a synthetic item row pointing at a different node in the same source
// conversation, so the thread fetch re-roots on a clicked ancestor/descendant.
// `focus` is the source-platform id carried on ExternalThreadEntry.id. The base
// row supplies the trusted protocol + host; focus only redirects the node.
function deriveFocusItem(base: ExternalItemRow, focus: string): ExternalItemRow {
  if (base.protocol === "atproto") {
    // Bluesky entry ids are self-contained at:// URIs; getPostThread takes one
    // directly, and fetchBlueskyThread reads interaction_data.uri first.
    return { ...base, source_item_uri: focus, interaction_data: { uri: focus } };
  }
  if (base.protocol === "activitypub") {
    // Mastodon entry ids are local status ids on the base instance. Rebuild a
    // URL on the base host so the host derivation + extractMastodonStatusId in
    // fetchMastodonThread resolve to /api/v1/statuses/<id>/context. The id only
    // ever reaches the source as a numeric path segment (no SSRF surface).
    let host = "";
    try {
      host = new URL(base.source_item_uri).hostname;
    } catch {
      host = "";
    }
    return { ...base, source_item_uri: `https://${host}/x/${focus}` };
  }
  return base;
}
