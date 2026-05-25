import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// external_parent_prefetch — eagerly fetch parent posts for reply items
//
// Enqueued when a new external_items row is inserted with source_reply_uri.
// Fetches the parent from the source platform and stores it as a context-only
// item (never inserted into feed_items). This means the gateway's /parent
// endpoint can serve from DB instead of hitting the source API live.
// =============================================================================

const APPVIEW = "https://public.api.bsky.app";

interface Payload {
  sourceReplyUri: string;
  protocol: string;
  sourceId: string;
}

export const externalParentPrefetch: Task = async (payload, _helpers) => {
  const { sourceReplyUri, protocol, sourceId } = payload as Payload;

  if (!sourceReplyUri || !protocol || !sourceId) return;

  // Check if parent already exists
  const { rowCount } = await pool.query(
    `SELECT 1 FROM external_items WHERE source_item_uri = $1 AND protocol = $2 LIMIT 1`,
    [sourceReplyUri, protocol],
  );

  if (rowCount && rowCount > 0) return;

  if (protocol === "atproto") {
    await prefetchBlueskyParent(sourceReplyUri, sourceId);
  } else if (protocol === "activitypub") {
    await prefetchMastodonParent(sourceReplyUri, sourceId);
  }
};

async function prefetchBlueskyParent(
  parentUri: string,
  sourceId: string,
): Promise<void> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", parentUri);

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return;

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
      }>;
    };

    const post = data.posts?.[0];
    if (!post) return;

    const parentReplyUri = post.record.reply?.parent.uri ?? null;

    let grandparent: { authorName: string; authorHandle: string } | null = null;
    if (parentReplyUri) {
      grandparent = await fetchBlueskyGrandparentTag(parentReplyUri);
    }

    const interactionData: Record<string, unknown> = {
      uri: post.uri,
      cid: post.cid,
    };
    if (grandparent) interactionData.grandparent = grandparent;

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
      "Bluesky parent prefetch failed",
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
