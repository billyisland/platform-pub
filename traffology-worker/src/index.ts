import 'dotenv/config'
import { run, parseCrontab } from 'graphile-worker'
import { pool } from '../shared/src/db/client.js'
import logger from '../shared/src/lib/logger.js'
import { aggregateHourly } from './tasks/aggregate-hourly.js'
import { aggregateDaily } from './tasks/aggregate-daily.js'
import { aggregateWeekly } from './tasks/aggregate-weekly.js'
import { resolveSource } from './tasks/resolve-source.js'
import { interpret } from './tasks/interpret.js'

// =============================================================================
// Traffology Worker
//
// Background job runner using Graphile Worker. No HTTP server — pure
// background processing. All jobs use the shared PostgreSQL connection.
//
// Scheduled jobs:
//   aggregate_hourly  — piece_stats, source_stats, half_day_buckets
//   aggregate_daily   — writer_baselines, publication_baselines
//   aggregate_weekly  — topic_performance
//   interpret         — generate observations from aggregated data
//
// Reactive jobs (queued by triggers or other jobs):
//   resolve_source    — resolve a session's referrer into a traffology.sources row
// =============================================================================

async function start() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    logger.error('DATABASE_URL is required')
    process.exit(1)
  }

  const runner = await run({
    connectionString,
    concurrency: 5,
    noHandleSignals: false,
    pollInterval: 2000,
    parsedCronItems: parseCrontab(
      [
        // Hourly at :05 (give ingest a few minutes to flush)
        '5 * * * * aggregate_hourly',
        // Daily at 00:15 UTC
        '15 0 * * * aggregate_daily',
        // Weekly on Monday at 01:00 UTC
        '0 1 * * 1 aggregate_weekly',
        // Interpret: run at :20 (after hourly aggregation completes)
        '20 * * * * interpret',
      ].join('\n')
    ),
    taskList: {
      aggregate_hourly: aggregateHourly,
      aggregate_daily: aggregateDaily,
      aggregate_weekly: aggregateWeekly,
      resolve_source: resolveSource,
      interpret,
    },
  })

  logger.info('Traffology worker started')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down traffology-worker')
    await runner.stop()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  await runner.promise
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start traffology-worker')
  process.exit(1)
})
