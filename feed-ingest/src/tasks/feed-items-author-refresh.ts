import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// feed_items_author_refresh — daily metadata propagation
//
// Propagates changed author metadata from source tables to the denormalised
// feed_items columns. Two passes:
//   1. Native accounts → feed_items (display_name, avatar, username)
//   2. External sources → feed_items (display_name, avatar_url)
//
// Up to 24 hours of staleness is acceptable per design.
// Runs daily at 04:00 UTC. See docs/adr/UNIVERSAL-FEED-ADR.md §V.2.
// =============================================================================

export const feedItemsAuthorRefresh: Task = async (_payload, _helpers) => {
  // 1. Refresh native author metadata (articles + notes)
  const nativeResult = await pool.query(`
    UPDATE feed_items fi SET
      author_name = COALESCE(acc.display_name, acc.username, 'Unknown'),
      author_avatar = acc.avatar_blossom_url,
      author_username = acc.username
    FROM accounts acc
    WHERE fi.author_id = acc.id
      AND fi.deleted_at IS NULL
      AND (
        fi.author_name IS DISTINCT FROM COALESCE(acc.display_name, acc.username, 'Unknown')
        OR fi.author_avatar IS DISTINCT FROM acc.avatar_blossom_url
        OR fi.author_username IS DISTINCT FROM acc.username
      )
  `)

  // 2. Refresh external source metadata
  const externalResult = await pool.query(`
    UPDATE feed_items fi SET
      author_name = COALESCE(ei.author_name, xs.display_name, fi.author_name),
      author_avatar = COALESCE(ei.author_avatar_url, xs.avatar_url, fi.author_avatar)
    FROM external_items ei
    JOIN external_sources xs ON xs.id = ei.source_id
    WHERE fi.external_item_id = ei.id
      AND fi.deleted_at IS NULL
      AND (
        fi.author_name IS DISTINCT FROM COALESCE(ei.author_name, xs.display_name, fi.author_name)
        OR fi.author_avatar IS DISTINCT FROM COALESCE(ei.author_avatar_url, xs.avatar_url, fi.author_avatar)
      )
  `)

  const nativeUpdated = nativeResult.rowCount ?? 0
  const externalUpdated = externalResult.rowCount ?? 0

  if (nativeUpdated > 0 || externalUpdated > 0) {
    logger.info({ nativeUpdated, externalUpdated }, 'feed_items author metadata refreshed')
  }
}
