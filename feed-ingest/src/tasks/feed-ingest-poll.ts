import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

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
     WHERE key IN ('feed_ingest_max_per_host', 'feed_ingest_max_concurrent', 'jetstream_healthy')`
  )
  const config = new Map(configRows.map(r => [r.key, r.value]))
  const maxPerHost = parseInt(config.get('feed_ingest_max_per_host') ?? '', 10) || 2
  const maxConcurrent = parseInt(config.get('feed_ingest_max_concurrent') ?? '', 10) || 10
  // atproto sources are normally pushed by the Jetstream listener. Only
  // fall back to polling via getAuthorFeed if the listener has reported
  // itself unhealthy — otherwise we'd duplicate work.
  const jetstreamHealthy = config.get('jetstream_healthy') !== 'false'

  // Find sources due for polling
  const { rows: sources } = await pool.query<{
    id: string
    protocol: string
    source_uri: string
    relay_urls: string[] | null
  }>(`
    SELECT id, protocol, source_uri, relay_urls
    FROM external_sources
    WHERE is_active = TRUE
      AND (protocol != 'atproto' OR $1::boolean = FALSE)
      AND (
        last_fetched_at IS NULL
        OR last_fetched_at + (fetch_interval_seconds || ' seconds')::interval <= now()
      )
    ORDER BY last_fetched_at ASC NULLS FIRST
    LIMIT 100
  `, [jetstreamHealthy])

  if (sources.length === 0) return

  // Group by hostname for rate limiting
  // RSS: group by feed URL hostname
  // Nostr: group by first relay URL hostname (rate limit per relay, not per pubkey)
  const byHost = new Map<string, typeof sources>()
  for (const source of sources) {
    let hostname: string
    if (source.protocol === 'nostr_external' && source.relay_urls && source.relay_urls.length > 0) {
      try {
        hostname = new URL(source.relay_urls[0]).hostname
      } catch {
        hostname = source.source_uri
      }
    } else {
      try {
        hostname = new URL(source.source_uri).hostname
      } catch {
        hostname = source.source_uri
      }
    }
    const group = byHost.get(hostname) ?? []
    group.push(source)
    byHost.set(hostname, group)
  }

  // Enqueue jobs respecting per-host and global limits
  let totalEnqueued = 0
  for (const [_hostname, hostSources] of byHost) {
    const toEnqueue = hostSources.slice(0, maxPerHost)
    for (const source of toEnqueue) {
      if (totalEnqueued >= maxConcurrent) break

      const taskName = source.protocol === 'rss' ? 'feed_ingest_rss'
                     : source.protocol === 'nostr_external' ? 'feed_ingest_nostr'
                     : source.protocol === 'activitypub' ? 'feed_ingest_activitypub'
                     : source.protocol === 'atproto' && !jetstreamHealthy ? 'feed_ingest_atproto_backfill'
                     : null
      if (!taskName) continue

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
