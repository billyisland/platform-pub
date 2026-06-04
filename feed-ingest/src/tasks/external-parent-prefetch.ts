import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// external_parent_prefetch — eagerly fetch neighbourhood context (parent posts
// for replies, and quoted posts for quote posts).
//
// Enqueued when a new external_items row is inserted with source_reply_uri
// and/or source_quote_uri. Fetches the related post from the source platform
// and stores it as a context-only item (never inserted into feed_items). This
// means the gateway's /parent and /quote endpoints can serve from DB instead of
// hitting the source API live on the first render.
// =============================================================================

const APPVIEW = "https://public.api.bsky.app";
const GETPOSTS_MAX_URIS = 25;
// Debounce window for coalescing per-job prefetch requests into shared 25-URI
// getPosts batches (#9 / B4). On a reply-heavy firehose each reply used to
// enqueue a job doing single-URI fetches (plus a serial grandparent fetch);
// debouncing collapses that storm into a couple of batched calls.
const PREFETCH_DEBOUNCE_MS = 250;

interface Payload {
  sourceReplyUri?: string | null;
  sourceQuoteUri?: string | null;
  protocol: string;
  sourceId: string;
}

// Shape returned by app.bsky.feed.getPosts, covering both the parent (reply
// tag) and quote (embed media) storage paths.
interface BlueskyPost {
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
}

async function alreadyStored(uri: string, protocol: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM external_items WHERE source_item_uri = $1 AND protocol = $2 LIMIT 1`,
    [uri, protocol],
  );
  return !!rowCount && rowCount > 0;
}

export const externalParentPrefetch: Task = async (payload, _helpers) => {
  const { sourceReplyUri, sourceQuoteUri, protocol, sourceId } =
    payload as Payload;

  if (!protocol || !sourceId) return;

  if (protocol === "atproto") {
    // Route atproto requests through the shared debounce accumulator so many
    // concurrent reply jobs collapse into batched getPosts calls. The job stays
    // in-flight (awaiting its batch) so graphile-worker backpressure still
    // applies.
    const waits: Promise<void>[] = [];
    if (sourceReplyUri)
      waits.push(enqueueAtprotoPrefetch("parent", sourceReplyUri, sourceId));
    if (sourceQuoteUri)
      waits.push(enqueueAtprotoPrefetch("quote", sourceQuoteUri, sourceId));
    await Promise.all(waits);
    return;
  }

  if (protocol === "activitypub") {
    // ActivityPub is outbox-polled (lower volume) and has no batch status API,
    // so it keeps the per-item path.
    if (sourceReplyUri && !(await alreadyStored(sourceReplyUri, protocol))) {
      await prefetchMastodonParent(sourceReplyUri, sourceId);
    }
    if (sourceQuoteUri && !(await alreadyStored(sourceQuoteUri, protocol))) {
      await prefetchMastodonQuote(sourceQuoteUri, sourceId);
    }
  }
};

// ---------------------------------------------------------------------------
// atproto debounce accumulator (#9 / B4)
//
// Per-job requests land in module-level buffers and await a shared batch
// promise. A flush fires on a 250ms debounce, or immediately once the buffer
// reaches 25 URIs, and resolves every awaiter of that batch.
// ---------------------------------------------------------------------------

interface AtprotoRequest {
  uri: string;
  sourceId: string;
}

let pendingParents: AtprotoRequest[] = [];
let pendingQuotes: AtprotoRequest[] = [];
let batchPromise: Promise<void> | null = null;
let batchResolve: (() => void) | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function ensureBatch(): Promise<void> {
  if (!batchPromise) {
    batchPromise = new Promise<void>((res) => {
      batchResolve = res;
    });
  }
  return batchPromise;
}

function scheduleFlush(): void {
  if (pendingParents.length + pendingQuotes.length >= GETPOSTS_MAX_URIS) {
    void runAtprotoFlush();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      void runAtprotoFlush();
    }, PREFETCH_DEBOUNCE_MS);
  }
}

function enqueueAtprotoPrefetch(
  kind: "parent" | "quote",
  uri: string,
  sourceId: string,
): Promise<void> {
  const promise = ensureBatch();
  (kind === "parent" ? pendingParents : pendingQuotes).push({ uri, sourceId });
  scheduleFlush();
  return promise;
}

async function runAtprotoFlush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Snapshot + reset so requests arriving during the flush form the next batch.
  const parents = pendingParents;
  const quotes = pendingQuotes;
  const resolve = batchResolve;
  pendingParents = [];
  pendingQuotes = [];
  batchPromise = null;
  batchResolve = null;

  try {
    if (parents.length > 0 || quotes.length > 0) {
      await flushAtprotoBatch(parents, quotes);
    }
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "atproto prefetch batch failed",
    );
  } finally {
    resolve?.();
  }
}

// Return the subset of `uris` already present in external_items (single SELECT).
async function storedAtprotoUris(uris: string[]): Promise<Set<string>> {
  if (uris.length === 0) return new Set();
  const { rows } = await pool.query<{ source_item_uri: string }>(
    `SELECT source_item_uri FROM external_items
     WHERE protocol = 'atproto' AND source_item_uri = ANY($1)`,
    [uris],
  );
  return new Set(rows.map((r) => r.source_item_uri));
}

// Fetch posts for `uris` in 25-URI getPosts chunks, merged into one map.
async function getPostsBatched(
  uris: string[],
): Promise<Map<string, BlueskyPost>> {
  const out = new Map<string, BlueskyPost>();
  for (let i = 0; i < uris.length; i += GETPOSTS_MAX_URIS) {
    const chunk = uris.slice(i, i + GETPOSTS_MAX_URIS);
    try {
      const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
      for (const uri of chunk) url.searchParams.append("uris", uri);
      const res = await safeFetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) continue;
      const data = JSON.parse(res.text) as { posts: BlueskyPost[] };
      for (const post of data.posts ?? []) out.set(post.uri, post);
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "getPosts batch failed during prefetch",
      );
    }
  }
  return out;
}

async function flushAtprotoBatch(
  parents: AtprotoRequest[],
  quotes: AtprotoRequest[],
): Promise<void> {
  // Dedupe by URI (first requester's sourceId wins, matching the old
  // race-to-insert behaviour under ON CONFLICT DO NOTHING).
  const parentByUri = new Map<string, string>();
  for (const r of parents) if (!parentByUri.has(r.uri)) parentByUri.set(r.uri, r.sourceId);
  const quoteByUri = new Map<string, string>();
  for (const r of quotes) if (!quoteByUri.has(r.uri)) quoteByUri.set(r.uri, r.sourceId);

  // Drop URIs already stored (one batched SELECT over the union).
  const union = [...new Set([...parentByUri.keys(), ...quoteByUri.keys()])];
  for (const u of await storedAtprotoUris(union)) {
    parentByUri.delete(u);
    quoteByUri.delete(u);
  }

  const fetchUris = [...new Set([...parentByUri.keys(), ...quoteByUri.keys()])];
  if (fetchUris.length === 0) return;

  const postByUri = await getPostsBatched(fetchUris);

  // Grandparent author tags for parents that are themselves replies — resolved
  // in a single second batched getPosts rather than one call per parent.
  const grandparentUris = new Set<string>();
  for (const uri of parentByUri.keys()) {
    const gpUri = postByUri.get(uri)?.record.reply?.parent.uri;
    if (gpUri) grandparentUris.add(gpUri);
  }
  const grandparentPosts =
    grandparentUris.size > 0
      ? await getPostsBatched([...grandparentUris])
      : new Map<string, BlueskyPost>();

  for (const [uri, sourceId] of parentByUri) {
    const post = postByUri.get(uri);
    if (!post) continue;
    const gpUri = post.record.reply?.parent.uri ?? null;
    const gpPost = gpUri ? grandparentPosts.get(gpUri) : null;
    const grandparent = gpPost
      ? {
          authorName: gpPost.author.displayName || gpPost.author.handle,
          authorHandle: gpPost.author.handle,
        }
      : null;
    await insertBlueskyParent(uri, sourceId, post, grandparent);
  }

  for (const [uri, sourceId] of quoteByUri) {
    const post = postByUri.get(uri);
    if (!post) continue;
    await insertBlueskyQuote(uri, sourceId, post);
  }
}

async function insertBlueskyParent(
  parentUri: string,
  sourceId: string,
  post: BlueskyPost,
  grandparent: { authorName: string; authorHandle: string } | null,
): Promise<void> {
  const parentReplyUri = post.record.reply?.parent.uri ?? null;
  const interactionData: Record<string, unknown> = {
    uri: post.uri,
    cid: post.cid,
  };
  if (grandparent) interactionData.grandparent = grandparent;

  try {
    await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_text, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'post', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO NOTHING`,
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
    logger.debug({ parentUri }, "Prefetched Bluesky parent");
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), parentUri },
      "Bluesky parent insert failed",
    );
  }
}

async function prefetchMastodonParent(
  parentUri: string,
  sourceId: string,
): Promise<void> {
  const statusId = extractMastodonStatusId(parentUri);
  if (!statusId) return;

  try {
    const host = new URL(parentUri).hostname;
    const res = await safeFetch(`https://${host}/api/v1/statuses/${statusId}`, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return;

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

    const media = (status.media_attachments ?? []).map((m) => ({
      type:
        m.type === "image" ? "image" : m.type === "video" ? "video" : "link",
      url: m.url,
      thumbnail: m.preview_url,
      alt: m.description,
    }));

    let grandparent: { authorName: string; authorHandle: string } | null = null;
    if (status.in_reply_to_id) {
      grandparent = await fetchMastodonGrandparentTag(
        host,
        status.in_reply_to_id,
      );
    }

    const interactionData: Record<string, unknown> = {
      id: status.uri,
      webUrl: status.url,
    };
    if (grandparent) interactionData.grandparent = grandparent;

    await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_html, content_text, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'post', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO NOTHING`,
      [
        sourceId,
        "activitypub",
        status.url || parentUri,
        status.account.display_name || status.account.acct,
        status.account.acct,
        status.account.avatar ?? null,
        status.account.url,
        status.content,
        null,
        JSON.stringify(media),
        null,
        JSON.stringify(interactionData),
        status.favourites_count ?? 0,
        status.replies_count ?? 0,
        status.reblogs_count ?? 0,
        new Date(status.created_at),
      ],
    );

    logger.debug({ parentUri }, "Prefetched Mastodon parent");
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), parentUri },
      "Mastodon parent prefetch failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Quote prefetch — stores the quoted post as a context-only item with its own
// media (image/video/link card) so the /quote tile renders warm.
// ---------------------------------------------------------------------------

interface QuoteMedia {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  title?: string;
  description?: string;
}

// Bluesky hydrated (#view) embeds carry full CDN URLs. recordWithMedia keeps
// media alongside the nested record; we extract the media but do not recurse
// into the nested quoted record (no quote-of-quote).
export function extractBlueskyViewMedia(embed: unknown): QuoteMedia[] {
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

export function mastodonCardToMedia(card: any): QuoteMedia | null {
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

async function insertBlueskyQuote(
  quoteUri: string,
  sourceId: string,
  post: BlueskyPost,
): Promise<void> {
  try {
    const media = extractBlueskyViewMedia(post.embed);

    await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_text, media, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'post', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO NOTHING`,
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

    logger.debug({ quoteUri }, "Prefetched Bluesky quote");
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), quoteUri },
      "Bluesky quote prefetch failed",
    );
  }
}

async function prefetchMastodonQuote(
  quoteUri: string,
  sourceId: string,
): Promise<void> {
  const statusId = extractMastodonStatusId(quoteUri);
  if (!statusId) return;

  try {
    const host = new URL(quoteUri).hostname;
    const res = await safeFetch(`https://${host}/api/v1/statuses/${statusId}`, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return;

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
      card?: any;
    };

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

    await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_html, content_text, media, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'post', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO NOTHING`,
      [
        sourceId,
        "activitypub",
        status.url || quoteUri,
        status.account.display_name || status.account.acct,
        status.account.acct,
        status.account.avatar ?? null,
        status.account.url,
        status.content,
        null,
        JSON.stringify(media),
        JSON.stringify({ id: status.uri, webUrl: status.url }),
        status.favourites_count ?? 0,
        status.replies_count ?? 0,
        status.reblogs_count ?? 0,
        new Date(status.created_at),
      ],
    );

    logger.debug({ quoteUri }, "Prefetched Mastodon quote");
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), quoteUri },
      "Mastodon quote prefetch failed",
    );
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
