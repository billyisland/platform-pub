import type { Task } from 'graphile-worker'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import logger from '../../shared/src/lib/logger.js'
import { fetchRssFeed } from '../adapters/rss.js'

// =============================================================================
// feed_ingest_rss — per-source RSS fetch job
//
// Fetches a single RSS/Atom feed, normalises items, and upserts into
// external_items. Updates source metadata and polling state.
// =============================================================================

export const feedIngestRss: Task = async (payload, _helpers) => {
  const { sourceId } = payload as { sourceId: string }

  // Load source
  const { rows: [source] } = await pool.query<{
    id: string
    source_uri: string
    cursor: string | null
    error_count: number
    display_name: string | null
  }>(`SELECT id, source_uri, cursor, error_count, display_name FROM external_sources WHERE id = $1`, [sourceId])

  if (!source) {
    logger.warn({ sourceId }, 'Source not found — skipping')
    return
  }

  // Load config
  const { rows: configRows } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_config
     WHERE key IN ('feed_ingest_max_items_per_fetch', 'feed_ingest_max_error_count',
                    'feed_ingest_error_backoff_factor')`
  )
  const config = new Map(configRows.map(r => [r.key, r.value]))
  const maxItems = parseInt(config.get('feed_ingest_max_items_per_fetch') ?? '50', 10)
  const maxErrors = parseInt(config.get('feed_ingest_max_error_count') ?? '10', 10)
  const backoffFactor = parseInt(config.get('feed_ingest_error_backoff_factor') ?? '2', 10)
  const DEFAULT_INTERVAL = 300

  // Parse cursor: we store etag and last-modified as JSON
  let etag: string | null = null
  let lastModified: string | null = null
  if (source.cursor) {
    try {
      const parsed = JSON.parse(source.cursor)
      etag = parsed.etag ?? null
      lastModified = parsed.lastModified ?? null
    } catch {
      // Legacy or corrupt cursor — ignore
    }
  }

  try {
    const result = await fetchRssFeed({
      feedUrl: source.source_uri,
      etag,
      lastModified,
    })

    if (result.notModified) {
      // Feed hasn't changed — update last_fetched_at only
      await pool.query(
        `UPDATE external_sources SET last_fetched_at = now(), error_count = 0, last_error = NULL, fetch_interval_seconds = $2, updated_at = now() WHERE id = $1`,
        [sourceId, DEFAULT_INTERVAL]
      )
      return
    }

    // Insert items (capped at maxItems) — dual-write to external_items + feed_items.
    // Sort newest-first so first-poll truncation drops oldest history, not new content.
    const sortedItems = [...result.items].sort(
      (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()
    )
    let inserted = 0
    for (const item of sortedItems.slice(0, maxItems)) {
      const didInsert = await withTransaction(async (client) => {
        const { rowCount, rows } = await client.query<{ id: string }>(`
          INSERT INTO external_items (
            source_id, protocol, tier,
            source_item_uri, author_name, author_handle, author_uri,
            content_text, content_html, summary, title, language,
            media, published_at
          ) VALUES (
            $1, 'rss', 'tier4',
            $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12
          )
          ON CONFLICT (protocol, source_item_uri) DO NOTHING
          RETURNING id
        `, [
          sourceId,
          item.sourceItemUri,
          item.authorName,
          item.authorHandle,
          item.authorUri,
          item.contentText,
          item.contentHtml,
          item.summary,
          item.title,
          item.language,
          JSON.stringify(item.media),
          item.publishedAt,
        ])

        if (!rowCount || rowCount === 0) return false

        // Dual-write: insert feed_items row
        await client.query(`
          INSERT INTO feed_items (
            item_type, external_item_id,
            author_name, author_avatar,
            title, content_preview,
            tier, published_at,
            source_protocol, source_item_uri, source_id, media
          ) VALUES (
            'external', $1,
            $2, $3,
            $4, $5,
            'tier4', $6,
            'rss', $7, $8, $9
          )
          ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING
        `, [
          rows[0].id,
          item.authorName ?? source.display_name ?? 'Unknown',
          null,
          item.title,
          (item.contentText ?? item.summary ?? '').slice(0, 200),
          item.publishedAt,
          item.sourceItemUri,
          sourceId,
          JSON.stringify(item.media),
        ])

        return true
      })
      if (didInsert) inserted++
    }

    // Update source: cursor, metadata, reset errors
    const newCursor = JSON.stringify({
      etag: result.etag ?? null,
      lastModified: result.lastModified ?? null,
    })

    await pool.query(`
      UPDATE external_sources SET
        last_fetched_at = now(),
        cursor = $2,
        display_name = COALESCE($3, display_name),
        description = COALESCE($4, description),
        error_count = 0,
        last_error = NULL,
        fetch_interval_seconds = $5,
        updated_at = now()
      WHERE id = $1
    `, [sourceId, newCursor, result.feedTitle ?? null, result.feedDescription ?? null, DEFAULT_INTERVAL])

    if (inserted > 0) {
      logger.info({ sourceId, inserted, total: result.items.length }, 'RSS items ingested')
    }

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const newErrorCount = source.error_count + 1
    const shouldDeactivate = newErrorCount >= maxErrors

    // Exponential backoff on the polling interval
    const backoffInterval = 300 * Math.pow(backoffFactor, Math.min(newErrorCount, 6))

    await pool.query(`
      UPDATE external_sources SET
        last_fetched_at = now(),
        error_count = $2,
        last_error = $3,
        is_active = CASE WHEN $4 THEN FALSE ELSE is_active END,
        fetch_interval_seconds = $5,
        updated_at = now()
      WHERE id = $1
    `, [sourceId, newErrorCount, errorMessage.slice(0, 1000), shouldDeactivate, Math.round(backoffInterval)])

    if (shouldDeactivate) {
      logger.warn({ sourceId, errorCount: newErrorCount }, 'Source deactivated after too many errors')
    } else {
      logger.warn({ sourceId, errorCount: newErrorCount, err: errorMessage }, 'RSS fetch failed')
    }
  }
}
