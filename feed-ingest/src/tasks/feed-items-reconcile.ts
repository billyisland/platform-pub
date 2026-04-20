import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// feed_items_reconcile — daily integrity check
//
// Detects and repairs drift between source tables and feed_items:
//   1. Published articles/notes with no feed_items row → INSERT
//   2. External items with no feed_items row → INSERT
//   3. feed_items pointing to deleted/missing sources → clean up
//
// Runs daily at 05:00 UTC. See docs/adr/UNIVERSAL-FEED-ADR.md §XV.7.
//
// Any non-zero count means a dual-write path leaked — transactional writes
// should keep feed_items in lockstep with the source tables. We log WARN
// (not INFO) with per-case counts so on-call sees *which* path regressed,
// rather than noticing only that "something" drifted.
// =============================================================================

export const feedItemsReconcile: Task = async (_payload, _helpers) => {
  // 1. Articles missing from feed_items
  const articlesResult = await pool.query(`
    INSERT INTO feed_items (
      item_type, article_id, author_id,
      author_name, author_avatar, author_username,
      title, content_preview, nostr_event_id,
      tier, published_at
    )
    SELECT
      'article', a.id, a.writer_id,
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
      AND NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.article_id = a.id)
    ON CONFLICT DO NOTHING
  `)
  const articlesInserted = articlesResult.rowCount ?? 0

  // 2. Notes missing from feed_items
  const notesResult = await pool.query(`
    INSERT INTO feed_items (
      item_type, note_id, author_id,
      author_name, author_avatar, author_username,
      content_preview, nostr_event_id,
      tier, published_at
    )
    SELECT
      'note', n.id, n.author_id,
      COALESCE(acc.display_name, acc.username, 'Unknown'),
      acc.avatar_blossom_url,
      acc.username,
      LEFT(n.content, 200),
      n.nostr_event_id,
      'tier1',
      n.published_at
    FROM notes n
    JOIN accounts acc ON acc.id = n.author_id
    WHERE NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.note_id = n.id)
    ON CONFLICT DO NOTHING
  `)
  const notesInserted = notesResult.rowCount ?? 0

  // 3. External items missing from feed_items
  const externalResult = await pool.query(`
    INSERT INTO feed_items (
      item_type, external_item_id,
      author_name, author_avatar,
      title, content_preview,
      tier, published_at,
      source_protocol, source_item_uri, source_id, media
    )
    SELECT
      'external', ei.id,
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
      AND NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.external_item_id = ei.id)
    ON CONFLICT DO NOTHING
  `)
  const externalsInserted = externalResult.rowCount ?? 0

  // 4. feed_items with soft-deleted articles that weren't caught
  const staleArticlesResult = await pool.query(`
    UPDATE feed_items fi SET deleted_at = now()
    FROM articles a
    WHERE fi.article_id = a.id
      AND a.deleted_at IS NOT NULL
      AND fi.deleted_at IS NULL
  `)
  const staleArticlesFixed = staleArticlesResult.rowCount ?? 0

  // 5. feed_items for external items that were soft-deleted
  const staleExternalResult = await pool.query(`
    UPDATE feed_items fi SET deleted_at = now()
    FROM external_items ei
    WHERE fi.external_item_id = ei.id
      AND ei.deleted_at IS NOT NULL
      AND fi.deleted_at IS NULL
  `)
  const staleExternalsFixed = staleExternalResult.rowCount ?? 0

  const anyDrift =
    articlesInserted + notesInserted + externalsInserted +
    staleArticlesFixed + staleExternalsFixed

  // Any non-zero case means a dual-write path leaked. Log at WARN so the
  // on-call dashboard surfaces it — reconcile existing at all is a safety
  // net, not a routine cleanup. Per-case counts point at which path.
  if (anyDrift > 0) {
    logger.warn(
      {
        articlesInserted,
        notesInserted,
        externalsInserted,
        staleArticlesFixed,
        staleExternalsFixed,
        totalDrift: anyDrift,
      },
      'feed_items reconcile repaired dual-write drift'
    )
  }
}
