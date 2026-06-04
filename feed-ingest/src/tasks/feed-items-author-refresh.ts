import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// feed_items_author_refresh — daily metadata propagation
//
// Propagates changed author metadata from source tables to the denormalised
// feed_items columns. Four passes:
//   1. Native accounts → feed_items (display_name, avatar, username)
//   2. External sources → feed_items (display_name, avatar_url)
//   3. Native reply-parent author → feed_items.reply_to_author
//   4. External reply-parent author → feed_items.reply_to_author
//
// Passes 3/4 fill late-arriving parents (a reply ingested before its parent has
// reply_to_author NULL until the parent lands) and track parent renames. The
// feed_items_post_identity trigger resolves reply_to_author best-effort on INSERT;
// these passes are the maintainer (migration 105, audit C4 / #11).
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

  // 3. Refresh native reply-parent author (display_name of the parent note's author)
  const nativeReplyResult = await pool.query(`
    UPDATE feed_items fi SET reply_to_author = acc_p.display_name
    FROM notes n
    JOIN notes n_p ON n_p.nostr_event_id = n.reply_to_event_id
    JOIN accounts acc_p ON acc_p.id = n_p.author_id
    WHERE fi.note_id = n.id
      AND fi.is_reply
      AND fi.deleted_at IS NULL
      AND fi.reply_to_author IS DISTINCT FROM acc_p.display_name
  `)

  // 4. Refresh external reply-parent author (author_handle of the parent item).
  //    Constrain on protocol so the parent lookup hits UNIQUE(protocol, source_item_uri).
  const externalReplyResult = await pool.query(`
    UPDATE feed_items fi SET reply_to_author = ei_p.author_handle
    FROM external_items ei
    JOIN external_items ei_p
      ON ei_p.protocol = ei.protocol
     AND ei_p.source_item_uri = ei.source_reply_uri
    WHERE fi.external_item_id = ei.id
      AND fi.is_reply
      AND fi.deleted_at IS NULL
      AND fi.reply_to_author IS DISTINCT FROM ei_p.author_handle
  `)

  const nativeUpdated = nativeResult.rowCount ?? 0
  const externalUpdated = externalResult.rowCount ?? 0
  const nativeReplyUpdated = nativeReplyResult.rowCount ?? 0
  const externalReplyUpdated = externalReplyResult.rowCount ?? 0

  if (nativeUpdated > 0 || externalUpdated > 0 || nativeReplyUpdated > 0 || externalReplyUpdated > 0) {
    logger.info(
      { nativeUpdated, externalUpdated, nativeReplyUpdated, externalReplyUpdated },
      'feed_items author metadata refreshed',
    )
  }
}
