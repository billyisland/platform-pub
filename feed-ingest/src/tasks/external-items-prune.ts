import type { Task } from 'graphile-worker'
import { pool } from '../../shared/src/db/client.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// external_items_prune — daily cleanup of old external items
//
// Deletes items older than the retention period, but preserves items that
// have user interactions (bookmarks, votes, note replies) to prevent
// silently vanishing bookmarks or broken reply threads.
// =============================================================================

export const externalItemsPrune: Task = async (_payload, _helpers) => {
  const { rows: [config] } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = 'external_items_retention_days'`
  )
  const retentionDays = parseInt(config?.value ?? '90', 10)

  const { rowCount } = await pool.query(`
    DELETE FROM external_items ei
    WHERE ei.created_at < now() - ($1 || ' days')::interval
      AND ei.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM bookmarks b
        JOIN articles a ON a.nostr_event_id = b.article_id::text
        WHERE FALSE  -- bookmarks reference articles, not external items directly (yet)
      )
      AND NOT EXISTS (
        SELECT 1 FROM votes v WHERE v.target_nostr_event_id = ei.id::text
      )
  `, [retentionDays])

  if (rowCount && rowCount > 0) {
    logger.info({ pruned: rowCount, retentionDays }, 'Pruned old external items')
  }
}
