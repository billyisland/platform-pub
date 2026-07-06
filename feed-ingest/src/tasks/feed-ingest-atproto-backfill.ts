import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  normaliseAtprotoPost,
  type BskyPostRecord,
} from "../adapters/atproto.js";
import { insertAtprotoItem } from "../lib/atproto-ingest.js";

// =============================================================================
// feed_ingest_atproto_backfill — one-time backfill for a new Bluesky source.
//
// The Jetstream listener only sees posts published after it picks up the DID
// on its next 60s DID-refresh poll. This task fetches recent history via the
// AppView's app.bsky.feed.getAuthorFeed and writes it into external_items +
// feed_items, so a fresh subscription has content immediately rather than
// appearing empty until the author posts again.
//
// Runs once per subscription (enqueued from the subscribe endpoint). Duplicate
// or re-run invocations are safe — the ON CONFLICT DO NOTHING in the ingest
// writer dedupes against anything the listener has already captured.
// =============================================================================

const APPVIEW = "https://public.api.bsky.app";
const PAGE_LIMIT = 100;

// Fetch the actor's profile (handle + display name) from the public AppView.
// Used to enrich the source row so the Jetstream listener — whose live commits
// carry only the DID — always has a handle to attribute posts to. Returns null
// on any failure; enrichment then falls back to the first post's author.
async function fetchAtprotoProfile(
  actor: string,
): Promise<{ handle: string; displayName: string | null } | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.actor.getProfile`);
    url.searchParams.set("actor", actor);
    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = JSON.parse(res.text) as {
      handle?: unknown;
      displayName?: unknown;
    };
    if (typeof data.handle !== "string") return null;
    return {
      handle: data.handle,
      displayName:
        typeof data.displayName === "string" && data.displayName.trim() !== ""
          ? data.displayName
          : null,
    };
  } catch {
    return null;
  }
}

interface FeedViewPost {
  post: {
    uri: string;
    cid: string;
    author: {
      did: string;
      handle: string;
      displayName?: string;
      avatar?: string;
    };
    record: BskyPostRecord;
    indexedAt: string;
    likeCount?: number;
    replyCount?: number;
    repostCount?: number;
  };
  reason?: { $type: string }; // e.g. reasonRepost — skip these
}

interface AuthorFeedResponse {
  cursor?: string;
  feed: FeedViewPost[];
}

export const feedIngestAtprotoBackfill: Task = async (payload, helpers) => {
  const { sourceId } = payload as { sourceId: string };

  const {
    rows: [source],
  } = await pool.query<{
    id: string;
    source_uri: string;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
  }>(
    `SELECT id, source_uri, handle, display_name, avatar_url
      FROM external_sources
      WHERE id = $1 AND protocol = 'atproto' AND is_active = TRUE`,
    [sourceId],
  );

  if (!source) {
    logger.warn(
      { sourceId },
      "atproto source not found for backfill — skipping",
    );
    return;
  }

  // Resolve and persist the account's handle + display name onto the source
  // row. The listener attributes live posts from this handle (its commits have
  // no profile inline), and it also repairs any historical items that were
  // ingested before the handle was known (the "EXTERNAL" byline bug). Best
  // effort — a fetch failure just leaves enrichment to a later run — but a
  // failure on a source that STILL has no handle is recorded on the source
  // (error_count/last_error) instead of being wiped by the completion UPDATE
  // below: that wipe made a permanently-unresolvable DID (deleted account)
  // look "healthy, fetched a minute ago" forever while the listener's 60s
  // self-heal re-enqueued this task unbounded (2026-07-06 audit residual).
  // The listener's enrichment filter backs off on error_count.
  const profile = await fetchAtprotoProfile(source.source_uri);
  const enrichmentFailed = !profile && (!source.handle || source.handle.trim() === "");
  if (profile) {
    source.handle = profile.handle;
    source.display_name = source.display_name ?? profile.displayName;
    await pool.query(
      `UPDATE external_sources
          SET handle = $2,
              display_name = COALESCE(NULLIF(display_name, ''), $3),
              updated_at = now()
        WHERE id = $1`,
      [sourceId, profile.handle, profile.displayName],
    );
    await repairAtprotoAuthors(
      sourceId,
      source.source_uri,
      profile.handle,
      profile.displayName,
    );
  }

  const {
    rows: [cfgRow],
  } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = 'feed_ingest_atproto_backfill_hours'`,
  );
  const lookbackHours = parseInt(cfgRow?.value ?? "24", 10);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  let cursor: string | undefined;
  let inserted = 0;
  let seen = 0;
  // Hard cap on pages so a pathological actor can't trap the worker.
  const MAX_PAGES = 5;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed`);
      url.searchParams.set("actor", source.source_uri);
      url.searchParams.set("limit", String(PAGE_LIMIT));
      url.searchParams.set("filter", "posts_no_replies");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await safeFetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        logger.warn(
          { sourceId, status: res.status },
          "getAuthorFeed failed — ending backfill",
        );
        break;
      }

      const data = JSON.parse(res.text) as AuthorFeedResponse;
      if (!data.feed || data.feed.length === 0) break;

      let reachedCutoff = false;
      for (const entry of data.feed) {
        seen++;
        // Skip reposts in backfill — they're handled via the listener's
        // real-time feed once we ingest repost records (future work).
        if (entry.reason) continue;
        const post = entry.post;
        if (!post?.record || post.record.$type !== "app.bsky.feed.post")
          continue;

        const publishedAt =
          Date.parse(post.record.createdAt) ||
          Date.parse(post.indexedAt) ||
          Date.now();
        if (publishedAt < cutoff) {
          reachedCutoff = true;
          continue;
        }

        const item = normaliseAtprotoPost({
          did: post.author.did,
          uri: post.uri,
          cid: post.cid,
          record: post.record,
          fallbackDate: new Date(publishedAt),
          author: {
            handle: post.author.handle,
            displayName: post.author.displayName,
          },
        });

        try {
          const didInsert = await withTransaction(async (client) => {
            return insertAtprotoItem(client, source, item, {
              likeCount: post.likeCount,
              replyCount: post.replyCount,
              repostCount: post.repostCount,
            });
          });
          if (didInsert) {
            inserted++;
            if (item.sourceReplyUri || item.sourceQuoteUri) {
              void helpers.addJob("external_parent_prefetch", {
                sourceReplyUri: item.sourceReplyUri,
                sourceQuoteUri: item.sourceQuoteUri,
                protocol: "atproto",
                sourceId: source.id,
              });
            }
          }
        } catch (err) {
          logger.warn(
            {
              sourceId,
              uri: post.uri,
              err: err instanceof Error ? err.message : String(err),
            },
            "atproto backfill insert failed",
          );
        }
      }

      if (reachedCutoff) break;
      if (!data.cursor) break;
      cursor = data.cursor;
    }

    // Bump last_fetched_at so the poll-fallback scheduler respects the
    // fetch_interval_seconds cadence when Jetstream is unhealthy. The
    // listener also updates this column on every real-time event, so a
    // healthy source stays "recent" without hitting this path. Error
    // accounting resets ONLY when enrichment isn't still failing — see above.
    if (enrichmentFailed) {
      await pool.query(
        `UPDATE external_sources
            SET last_fetched_at = now(),
                error_count = error_count + 1,
                last_error = 'atproto handle enrichment failed (getProfile)',
                updated_at = now()
          WHERE id = $1`,
        [sourceId],
      );
    } else {
      await pool.query(
        `
        UPDATE external_sources
        SET last_fetched_at = now(),
            error_count = 0,
            last_error = NULL,
            updated_at = now()
        WHERE id = $1
      `,
        [sourceId],
      );
    }

    if (inserted > 0 || seen > 0) {
      logger.info(
        { sourceId, inserted, seen, lookbackHours },
        "atproto backfill complete",
      );
    }
  } catch (err) {
    logger.warn(
      { sourceId, err: err instanceof Error ? err.message : String(err) },
      "atproto backfill failed",
    );
  }
};

// Heal historical rows that were ingested before the source's handle was known
// and so carry a null/empty author name+handle (the byline that renders as
// "EXTERNAL"). Every item under an atproto source is authored by that source's
// single account, so the resolved (handle, displayName) applies to all of them.
// Only fills gaps — never overwrites an already-populated name/handle.
async function repairAtprotoAuthors(
  sourceId: string,
  did: string,
  handle: string,
  displayName: string | null,
): Promise<void> {
  const name = displayName ?? `@${handle}`;
  try {
    await pool.query(
      `UPDATE external_items
          SET author_name   = COALESCE(NULLIF(author_name, ''), $2),
              author_handle = COALESCE(NULLIF(author_handle, ''), $3)
        WHERE source_id = $1
          AND protocol = 'atproto'
          AND (author_name IS NULL OR author_name = ''
               OR author_handle IS NULL OR author_handle = '')`,
      [sourceId, name, handle],
    );
    // external_authors (migration 099) is minted from the external_items author
    // fields and keyed by stable_handle = the DID; its null display_name/handle
    // is what the byline reads via the xa join, so heal it directly by DID.
    await pool.query(
      `UPDATE external_authors
          SET display_name = COALESCE(NULLIF(display_name, ''), $1),
              handle       = COALESCE(NULLIF(handle, ''), $2)
        WHERE protocol = 'atproto'
          AND stable_handle = $3
          AND (display_name IS NULL OR display_name = ''
               OR handle IS NULL OR handle = '')`,
      [name, handle, did],
    );
    // feed_items carries its own denormalised author_name (legacy display path);
    // repair the "Bluesky user" / null placeholders for consistency.
    await pool.query(
      `UPDATE feed_items fi
          SET author_name = $2
         FROM external_items ei
        WHERE fi.external_item_id = ei.id
          AND ei.source_id = $1
          AND ei.protocol = 'atproto'
          AND (fi.author_name IS NULL OR fi.author_name = ''
               OR fi.author_name = 'Bluesky user')`,
      [sourceId, name],
    );
  } catch (err) {
    logger.warn(
      { sourceId, err: err instanceof Error ? err.message : String(err) },
      "atproto author repair failed",
    );
  }
}
