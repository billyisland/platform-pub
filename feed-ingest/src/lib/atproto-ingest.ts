import type { PoolClient } from "pg";
import type { NormalisedAtprotoItem } from "../adapters/atproto.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";

// =============================================================================
// Shared atproto ingest write path — used by both the Jetstream listener and
// the backfill job. Dual-writes external_items + feed_items with the same
// ON CONFLICT DO NOTHING pattern, so either caller can safely rewrite the
// same post without producing duplicate rows.
//
// Returns true if a new external_items row was inserted (i.e. not a dedupe
// hit), so callers can count newly-ingested items.
// =============================================================================

interface AtprotoIngestSource {
  id: string;
  source_uri: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

export interface EngagementCounts {
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
}

export async function insertAtprotoItem(
  client: PoolClient,
  source: AtprotoIngestSource,
  item: NormalisedAtprotoItem,
  counts?: EngagementCounts,
): Promise<boolean> {
  // Resolve the post author's identity. A live Jetstream commit carries only
  // the DID, so item.authorHandle/authorName are undefined there — fall back to
  // the source's stored handle/display_name (one atproto source = one author;
  // the source is enriched with its handle by the backfill task). Never leave
  // both name and handle null: that is the byline that renders as "EXTERNAL".
  const authorHandle = item.authorHandle ?? source.handle ?? null;
  const authorName =
    item.authorName ??
    source.display_name ??
    (authorHandle ? `@${authorHandle}` : null);
  // The author's profile URI (their DID). Was previously the source's DID; now
  // the post author's DID, which for a single-author source is identical.
  const authorUri = item.authorDid ?? source.source_uri;

  const { rows, rowCount } = await client.query<{ id: string }>(
    `
    INSERT INTO external_items (
      source_id, protocol, tier,
      source_item_uri,
      author_name, author_handle, author_avatar_url, author_uri,
      content_text, content_html, language,
      media,
      source_reply_uri, source_quote_uri, is_repost,
      interaction_data,
      like_count, reply_count, repost_count,
      published_at
    ) VALUES (
      $1, 'atproto', 'tier3',
      $2,
      $3, $4, $5, $6,
      $7, $8, $9,
      $10,
      $11, $12, FALSE,
      $13,
      $14, $15, $16,
      $17
    )
    ON CONFLICT (protocol, source_item_uri) DO NOTHING
    RETURNING id
  `,
    [
      source.id,
      item.sourceItemUri,
      authorName,
      authorHandle,
      source.avatar_url ?? null,
      authorUri,
      item.contentText,
      item.contentHtml,
      item.language,
      JSON.stringify(item.media),
      item.sourceReplyUri,
      item.sourceQuoteUri,
      JSON.stringify(item.interactionData),
      counts?.likeCount ?? 0,
      counts?.replyCount ?? 0,
      counts?.repostCount ?? 0,
      item.publishedAt,
    ],
  );

  if (!rowCount || rowCount === 0) return false;

  await client.query(
    `
    INSERT INTO feed_items (
      item_type, external_item_id,
      author_name, author_avatar,
      title, content_preview,
      published_at,
      source_protocol, source_item_uri, source_id, media,
      is_reply
    ) VALUES (
      'external', $1,
      $2, $3,
      NULL, $4,
      $5,
      'atproto', $6, $7, $8,
      $9
    )
    ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING
  `,
    [
      rows[0].id,
      authorName ?? "Bluesky user",
      source.avatar_url,
      truncatePreview(item.contentText),
      item.publishedAt,
      item.sourceItemUri,
      source.id,
      JSON.stringify(item.media),
      item.sourceReplyUri != null,
    ],
  );

  return true;
}
