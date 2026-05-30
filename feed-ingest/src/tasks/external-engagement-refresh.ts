import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// external_engagement_refresh — periodic snapshot of engagement counts
//
// For external items published in the last 7 days, batch-fetch current
// like/reply/repost counts from source platforms and update the denormalised
// columns on external_items. Runs every 30 minutes via cron.
//
// Bluesky:  batch getPosts (up to 25 URIs per call)
// Mastodon: individual GET /statuses/:id, parallelised per instance
// Nostr:    skipped (relay REQ latency makes periodic refresh impractical)
// RSS:      no counts; always 0
// =============================================================================

const APPVIEW = "https://public.api.bsky.app";
const BSKY_BATCH_SIZE = 25;
const MASTODON_CONCURRENCY = 5;
const LOOKBACK_DAYS = 7;

interface ExternalItemRow {
  id: string;
  protocol: string;
  source_item_uri: string;
  interaction_data: Record<string, unknown>;
  media: MediaItem[];
}

interface MediaItem {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  title?: string;
  description?: string;
}

// Mastodon attaches an OpenGraph link preview to a status as a `card` object
// (Mastodon-API-only — it's never in the ActivityPub outbox the adapter polls).
// Normalise it into the same {type:"link"} media entry our cards already render
// for Bluesky's app.bsky.embed.external, so a previewed link looks identical
// regardless of source.
interface MastodonCard {
  url?: string;
  title?: string;
  description?: string;
  image?: string | null;
  type?: string; // "link" | "photo" | "video" | "rich"
}

export function cardToLinkMedia(
  card: MastodonCard | null | undefined,
): MediaItem | null {
  if (!card?.url) return null;
  // Only "link" cards become preview tiles; photo/video cards are already
  // represented by the status's media_attachments.
  if (card.type && card.type !== "link") return null;
  return {
    type: "link",
    url: card.url,
    thumbnail: card.image ?? undefined,
    title: card.title || undefined,
    description: card.description || undefined,
  };
}

// Replace any existing link entry with the fresh card, preserving image/video
// media. Returns null when nothing changed so the caller can skip the write.
export function mergeLinkMedia(
  existing: MediaItem[],
  link: MediaItem | null,
): MediaItem[] | null {
  const nonLink = (existing ?? []).filter((m) => m.type !== "link");
  const current = existing ?? [];
  const next = link ? [...nonLink, link] : nonLink;
  if (
    next.length === current.length &&
    JSON.stringify(next) === JSON.stringify(current)
  ) {
    return null;
  }
  return next;
}

export const externalEngagementRefresh: Task = async (_payload, _helpers) => {
  const cutoff = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { rows } = await pool.query<ExternalItemRow>(
    `SELECT id, protocol, source_item_uri, interaction_data, media
     FROM external_items
     WHERE published_at >= $1
       AND deleted_at IS NULL
       AND protocol IN ('atproto', 'activitypub')
     ORDER BY published_at DESC`,
    [cutoff],
  );

  if (rows.length === 0) return;

  const atprotoItems = rows.filter((r) => r.protocol === "atproto");
  const mastodonItems = rows.filter((r) => r.protocol === "activitypub");

  let updated = 0;

  if (atprotoItems.length > 0) {
    updated += await refreshBlueskyBatch(atprotoItems);
  }

  if (mastodonItems.length > 0) {
    updated += await refreshMastodonBatch(mastodonItems);
  }

  if (updated > 0) {
    logger.info(
      { updated, total: rows.length },
      "external engagement refresh complete",
    );
  }
};

// ---------------------------------------------------------------------------
// Bluesky — batch getPosts (25 URIs per call)
// ---------------------------------------------------------------------------

async function refreshBlueskyBatch(items: ExternalItemRow[]): Promise<number> {
  let updated = 0;

  for (let i = 0; i < items.length; i += BSKY_BATCH_SIZE) {
    const batch = items.slice(i, i + BSKY_BATCH_SIZE);
    const uris = batch.map((item) => item.source_item_uri);

    try {
      const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
      for (const uri of uris) {
        url.searchParams.append("uris", uri);
      }

      const res = await safeFetch(url.toString(), {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        logger.warn(
          { status: res.status, batch: i },
          "getPosts failed during engagement refresh",
        );
        continue;
      }

      const data = JSON.parse(res.text) as {
        posts: Array<{
          uri: string;
          likeCount?: number;
          replyCount?: number;
          repostCount?: number;
        }>;
      };

      const postMap = new Map(data.posts.map((p) => [p.uri, p]));

      for (const item of batch) {
        const post = postMap.get(item.source_item_uri);
        if (!post) continue;

        await pool.query(
          `UPDATE external_items
           SET like_count = $1, reply_count = $2, repost_count = $3
           WHERE id = $4`,
          [
            post.likeCount ?? 0,
            post.replyCount ?? 0,
            post.repostCount ?? 0,
            item.id,
          ],
        );
        updated++;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), batch: i },
        "Bluesky engagement refresh batch failed",
      );
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Mastodon — individual GET /api/v1/statuses/:id per instance
// ---------------------------------------------------------------------------

async function refreshMastodonBatch(items: ExternalItemRow[]): Promise<number> {
  let updated = 0;

  // Group items by instance host to respect per-instance rate limits
  const byHost = new Map<string, ExternalItemRow[]>();
  for (const item of items) {
    try {
      const host = new URL(item.source_item_uri).hostname;
      const group = byHost.get(host) ?? [];
      group.push(item);
      byHost.set(host, group);
    } catch {
      continue;
    }
  }

  // Process hosts in parallel (up to MASTODON_CONCURRENCY)
  const hosts = [...byHost.entries()];
  for (let i = 0; i < hosts.length; i += MASTODON_CONCURRENCY) {
    const hostBatch = hosts.slice(i, i + MASTODON_CONCURRENCY);
    const results = await Promise.allSettled(
      hostBatch.map(([host, hostItems]) =>
        refreshMastodonHost(host, hostItems),
      ),
    );
    for (const result of results) {
      if (result.status === "fulfilled") updated += result.value;
    }
  }

  return updated;
}

async function refreshMastodonHost(
  host: string,
  items: ExternalItemRow[],
): Promise<number> {
  let updated = 0;

  for (const item of items) {
    const statusId = extractMastodonStatusId(item.source_item_uri);
    if (!statusId) continue;

    try {
      const res = await safeFetch(
        `https://${host}/api/v1/statuses/${statusId}`,
        { headers: { Accept: "application/json" } },
      );

      if (!res.ok) continue;

      const status = JSON.parse(res.text) as {
        favourites_count?: number;
        replies_count?: number;
        reblogs_count?: number;
        card?: MastodonCard | null;
      };

      const mergedMedia = mergeLinkMedia(
        item.media,
        cardToLinkMedia(status.card),
      );

      await pool.query(
        mergedMedia
          ? `UPDATE external_items
             SET like_count = $1, reply_count = $2, repost_count = $3, media = $5
             WHERE id = $4`
          : `UPDATE external_items
             SET like_count = $1, reply_count = $2, repost_count = $3
             WHERE id = $4`,
        mergedMedia
          ? [
              status.favourites_count ?? 0,
              status.replies_count ?? 0,
              status.reblogs_count ?? 0,
              item.id,
              JSON.stringify(mergedMedia),
            ]
          : [
              status.favourites_count ?? 0,
              status.replies_count ?? 0,
              status.reblogs_count ?? 0,
              item.id,
            ],
      );
      updated++;
    } catch (err) {
      logger.debug(
        {
          host,
          uri: item.source_item_uri,
          err: err instanceof Error ? err.message : String(err),
        },
        "Mastodon status fetch failed during engagement refresh",
      );
    }
  }

  return updated;
}

function extractMastodonStatusId(uri: string): string | null {
  // Mastodon status URIs: https://instance.social/users/name/statuses/12345
  // or https://instance.social/@name/12345
  try {
    const parts = new URL(uri).pathname.split("/").filter(Boolean);
    // /users/name/statuses/ID or /@name/ID
    const last = parts[parts.length - 1];
    if (last && /^\d+$/.test(last)) return last;
    return null;
  } catch {
    return null;
  }
}
