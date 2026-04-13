import 'dotenv/config'
import { run, parseCrontab } from 'graphile-worker'
import { pool } from '../shared/src/db/client.js'
import logger from '../shared/src/lib/logger.js'
import { feedIngestPoll } from './tasks/feed-ingest-poll.js'
import { feedIngestRss } from './tasks/feed-ingest-rss.js'
import { externalItemsPrune } from './tasks/external-items-prune.js'
import { sourceMetadataRefresh } from './tasks/source-metadata-refresh.js'

// =============================================================================
// Feed Ingest Worker
//
// Background job runner using Graphile Worker. No HTTP server — pure
// background processing. All jobs use the shared PostgreSQL connection.
//
// Scheduled jobs:
//   feed_ingest_poll        — find sources due for polling, enqueue per-source jobs
//   external_items_prune    — delete expired external items (daily)
//   source_metadata_refresh — refresh source display metadata (daily)
//
// Reactive jobs (queued by poll or gateway):
//   feed_ingest_rss         — fetch + parse a single RSS source
// =============================================================================

async function start() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    logger.error('DATABASE_URL is required')
    process.exit(1)
  }

  const runner = await run({
    connectionString,
    concurrency: 10,
    noHandleSignals: false,
    pollInterval: 2000,
    parsedCronItems: parseCrontab(
      [
        // Poll for sources due for fetching — every 60 seconds
        '* * * * * feed_ingest_poll',
        // Prune old external items — daily at 02:00 UTC
        '0 2 * * * external_items_prune',
        // Refresh source metadata — daily at 03:00 UTC
        '0 3 * * * source_metadata_refresh',
      ].join('\n')
    ),
    taskList: {
      feed_ingest_poll: feedIngestPoll,
      feed_ingest_rss: feedIngestRss,
      external_items_prune: externalItemsPrune,
      source_metadata_refresh: sourceMetadataRefresh,
    },
  })

  logger.info('Feed ingest worker started')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down feed-ingest worker')
    await runner.stop()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  await runner.promise
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start feed-ingest worker')
  process.exit(1)
})
