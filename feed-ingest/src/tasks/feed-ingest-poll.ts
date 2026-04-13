import type { Task } from 'graphile-worker'
import { pool } from '../../shared/src/db/client.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// feed_ingest_poll — scheduled every 60 seconds
//
// Finds external_sources that are due for polling and enqueues per-source
// fetch jobs. Enforces per-host concurrency limits to be a good citizen.
// =============================================================================

export const feedIngestPoll: Task = async (_payload, helpers) => {
  // Load config values
  const { rows: configRows } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_config
     WHERE key IN ('feed_ingest_max_per_host', 'feed_ingest_max_concurrent')`
  )
  const config = new Map(configRows.map(r => [r.key, parseInt(r.value, 10)]))
  const maxPerHost = config.get('feed_ingest_max_per_host') ?? 2
  const maxConcurrent = config.get('feed_ingest_max_concurrent') ?? 10

  // Find sources due for polling
  const { rows: sources } = await pool.query<{
    id: string
    protocol: string
    source_uri: string
  }>(`
    SELECT id, protocol, source_uri
    FROM external_sources
    WHERE is_active = TRUE
      AND (
        last_fetched_at IS NULL
        OR last_fetched_at + (fetch_interval_seconds || ' seconds')::interval <= now()
      )
    ORDER BY last_fetched_at ASC NULLS FIRST
    LIMIT 100
  `)

  if (sources.length === 0) return

  // Group by hostname for rate limiting
  const byHost = new Map<string, typeof sources>()
  for (const source of sources) {
    let hostname: string
    try {
      hostname = new URL(source.source_uri).hostname
    } catch {
      hostname = source.source_uri  // non-URL identifiers (pubkeys, DIDs)
    }
    const group = byHost.get(hostname) ?? []
    group.push(source)
    byHost.set(hostname, group)
  }

  // Enqueue jobs respecting per-host and global limits
  let totalEnqueued = 0
  for (const [hostname, hostSources] of byHost) {
    const toEnqueue = hostSources.slice(0, maxPerHost)
    for (const source of toEnqueue) {
      if (totalEnqueued >= maxConcurrent) break

      const taskName = source.protocol === 'rss' ? 'feed_ingest_rss' : null
      if (!taskName) continue  // Only RSS in Phase 1

      await helpers.addJob(taskName, { sourceId: source.id }, {
        jobKey: `feed_ingest_${source.id}`,
        maxAttempts: 1,
      })
      totalEnqueued++
    }
    if (totalEnqueued >= maxConcurrent) break
  }

  if (totalEnqueued > 0) {
    logger.info({ count: totalEnqueued }, 'Enqueued feed ingest jobs')
  }
}
