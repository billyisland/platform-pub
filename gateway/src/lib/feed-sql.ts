import { UUID_RE } from "./uuid.js";
// =============================================================================
// Shared feed SQL — the candidate-gathering SELECT/JOINs over feed_items plus
// the keyset cursor parser, reused by every read path that projects feed_items:
//   post-feed.ts   (GET /feed/:feedId   — Post-model timeline)
//   post-thread.ts (GET /thread/:postId — Post-model thread)
//   sources.ts     (GET /sources/:id    — source surface, Post[])
//   author.ts      (GET /author/:id/... — author surface, Post[])
//   tags.ts        (GET /tags/:name/... — tag surface, Post[])
//
// Extracted from the retired legacy `GET /feed` handler (timeline.ts, deleted
// in FEED-RETIREMENT-PLAN Slice 6). The legacy row→response mapper
// (feedItemToResponse) and biddability helper died with that handler; these
// callers map rows to the Post shape via lib/post-mapper.ts instead.
// =============================================================================

export interface CursorParts {
  score?: number; // explore-feed ranking score — undefined on legacy cursors
  ts: number;
  id: string;
}


export function parseCursor(raw: string | undefined): CursorParts | undefined {
  if (!raw) return undefined;
  const parts = raw.split(":");
  // 3-part: "score:unix_seconds:uuid" — explore-feed compound cursor
  if (parts.length === 3) {
    const score = Number(parts[0]);
    const ts = parseInt(parts[1], 10);
    const id = parts[2];
    if (!isNaN(score) && !isNaN(ts) && UUID_RE.test(id))
      return { score, ts, id };
  }
  // 2-part: "unix_seconds:uuid" — following-feed cursor (legacy for explore too)
  if (parts.length === 2) {
    const ts = parseInt(parts[0], 10);
    const id = parts[1];
    if (!isNaN(ts) && UUID_RE.test(id)) return { ts, id };
  }
  // Legacy: plain unix seconds (no id component — use max uuid for stable ordering)
  const ts = parseInt(raw, 10);
  if (!isNaN(ts)) return { ts, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" };
  return undefined;
}

// Shared SELECT columns — feed_items + LEFT JOINs for type-specific fields
export const FEED_SELECT = `
  fi.id AS fi_id, fi.item_type, fi.title, fi.article_id, fi.note_id, fi.external_item_id,
  fi.author_id, fi.nostr_event_id, fi.source_protocol, fi.source_item_uri,
  fi.source_id, COALESCE(ei.media, fi.media) AS media, fi.score,
  EXTRACT(EPOCH FROM fi.published_at)::bigint AS published_at_epoch,
  -- Author pubkey (native content only — single join covers both articles and notes)
  acc.nostr_pubkey AS nostr_pubkey,
  -- Article-specific (NULL for non-articles)
  a.nostr_d_tag, a.access_mode, a.price_pence, a.gate_position_pct,
  a.content_free, a.summary AS a_summary, a.size_tier,
  COALESCE(
    (SELECT array_agg(t.name ORDER BY t.name)
     FROM article_tags at2 JOIN tags t ON t.id = at2.tag_id
     WHERE at2.article_id = a.id),
    '{}'
  ) AS tag_names,
  -- Note-specific (NULL for non-notes)
  n.content AS note_content, n.is_quote_comment,
  n.quoted_event_id, n.quoted_event_kind,
  n.quoted_excerpt, n.quoted_title, n.quoted_author,
  n.quoted_post_id, n.quoted_url, n.quoted_source,
  n.external_parent_id,
  -- External-specific (NULL for non-external)
  ei.author_name AS ei_author_name, ei.author_handle AS ei_author_handle,
  ei.author_avatar_url AS ei_author_avatar_url, ei.author_uri AS ei_author_uri,
  ei.content_text AS ei_content_text, ei.content_html AS ei_content_html,
  ei.title AS ei_title, ei.summary AS ei_summary,
  ei.source_reply_uri AS ei_source_reply_uri,
  ei.source_quote_uri AS ei_source_quote_uri,
  ei.content_warning AS ei_content_warning,
  ei.interaction_data AS ei_interaction_data,
  ei.like_count AS ei_like_count, ei.reply_count AS ei_reply_count,
  ei.repost_count AS ei_repost_count,
  xs.display_name AS source_display_name, xs.avatar_url AS source_avatar_url,
  -- Trust Layer 1 pip (NULL for external items — they default to 'unknown')
  tl.pip_status,
  -- Parent author for reply provenance — denormalised onto the row at ingest by the
  -- feed_items_post_identity trigger + maintained by feed_items_author_refresh
  -- (migration 105, audit C4 / #11). Replaces the per-candidate correlated subqueries
  -- (native parent note author's display_name; external parent item's author_handle).
  fi.reply_to_author,
  fi.is_reply
`;

export const FEED_JOINS = `
  LEFT JOIN articles a ON a.id = fi.article_id
  LEFT JOIN notes n ON n.id = fi.note_id
  LEFT JOIN accounts acc ON acc.id = fi.author_id
  LEFT JOIN external_items ei ON ei.id = fi.external_item_id
  LEFT JOIN external_sources xs ON xs.id = fi.source_id
  LEFT JOIN trust_layer1 tl ON tl.user_id = fi.author_id
`;
