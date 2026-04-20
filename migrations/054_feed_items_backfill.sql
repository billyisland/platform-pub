-- Migration 054: backfill feed_items from existing articles, notes, and external_items
--
-- Populates the feed_items table created in migration 053 with all existing content.
-- Idempotent via ON CONFLICT DO NOTHING on the unique partial indexes.
-- See docs/adr/UNIVERSAL-FEED-ADR.md §VII.2 (backfill migration).

-- 1. Articles (published, not deleted)
INSERT INTO feed_items (
  item_type, article_id, author_id,
  author_name, author_avatar, author_username,
  title, content_preview, nostr_event_id,
  tier, published_at
)
SELECT
  'article',
  a.id,
  a.writer_id,
  COALESCE(acc.display_name, acc.username, 'Unknown'),
  acc.avatar_blossom_url,
  acc.username,
  a.title,
  LEFT(a.content_free, 200),
  a.nostr_event_id,
  'tier1',
  a.published_at
FROM articles a
JOIN accounts acc ON acc.id = a.writer_id
WHERE a.published_at IS NOT NULL
  AND a.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- 2. Notes (all — notes have no soft-delete, no unpublished state)
INSERT INTO feed_items (
  item_type, note_id, author_id,
  author_name, author_avatar, author_username,
  content_preview, nostr_event_id,
  tier, published_at
)
SELECT
  'note',
  n.id,
  n.author_id,
  COALESCE(acc.display_name, acc.username, 'Unknown'),
  acc.avatar_blossom_url,
  acc.username,
  LEFT(n.content, 200),
  n.nostr_event_id,
  'tier1',
  n.published_at
FROM notes n
JOIN accounts acc ON acc.id = n.author_id
ON CONFLICT DO NOTHING;

-- 3. External items (not deleted)
INSERT INTO feed_items (
  item_type, external_item_id,
  author_name, author_avatar,
  title, content_preview,
  tier, published_at,
  source_protocol, source_item_uri, source_id, media
)
SELECT
  'external',
  ei.id,
  COALESCE(ei.author_name, xs.display_name, 'Unknown'),
  COALESCE(ei.author_avatar_url, xs.avatar_url),
  ei.title,
  LEFT(COALESCE(ei.content_text, ei.summary), 200),
  ei.tier,
  ei.published_at,
  ei.protocol::text,
  ei.source_item_uri,
  ei.source_id,
  ei.media
FROM external_items ei
JOIN external_sources xs ON xs.id = ei.source_id
WHERE ei.deleted_at IS NULL
ON CONFLICT DO NOTHING;
