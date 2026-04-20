import 'dotenv/config'
import { run, parseCrontab } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { feedIngestPoll } from './tasks/feed-ingest-poll.js'
import { feedIngestRss } from './tasks/feed-ingest-rss.js'
import { feedIngestNostr } from './tasks/feed-ingest-nostr.js'
import { externalItemsPrune } from './tasks/external-items-prune.js'
import { sourceMetadataRefresh } from './tasks/source-metadata-refresh.js'
import { feedItemsReconcile } from './tasks/feed-items-reconcile.js'
import { feedItemsAuthorRefresh } from './tasks/feed-items-author-refresh.js'
import { feedIngestAtprotoBackfill } from './tasks/feed-ingest-atproto-backfill.js'
import { feedIngestActivityPub } from './tasks/feed-ingest-activitypub.js'
import { outboundCrossPost } from './tasks/outbound-cross-post.js'
import { outboundTokenRefresh } from './tasks/outbound-token-refresh.js'
import { atprotoOauthStatesPrune } from './tasks/atproto-oauth-states-prune.js'
import { resolverResultsPrune } from './tasks/resolver-results-prune.js'
import { externalSourcesGc } from './tasks/external-sources-gc.js'
import { feedScoresRefresh } from './tasks/feed-scores-refresh.js'
import { trustLayer1Refresh } from './tasks/trust-layer1-refresh.js'
import { trustEpochAggregate } from './tasks/trust-epoch-aggregate.js'
import { JetstreamListener } from './jetstream/listener.js'

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
        // Refresh denormalised author metadata in feed_items — daily at 04:00 UTC
        '0 4 * * * feed_items_author_refresh',
        // Reconcile feed_items with source tables — daily at 05:00 UTC
        '0 5 * * * feed_items_reconcile',
        // Refresh expiring OAuth tokens for linked accounts — every 30 min
        '*/30 * * * * outbound_token_refresh',
        // Prune expired atproto OAuth pending states — every 5 min
        '*/5 * * * * atproto_oauth_states_prune',
        // Prune expired resolver Phase B results — every 5 min
        '*/5 * * * * resolver_results_prune',
        // Garbage-collect orphaned external_sources — daily at 06:00 UTC
        '0 6 * * * external_sources_gc',
        // Refresh feed_items.score from engagement — every 5 minutes
        '*/5 * * * * feed_scores_refresh',
        // Recompute Layer 1 trust signals — daily at 01:00 UTC
        '0 1 * * * trust_layer1_refresh',
        // Trust epoch aggregation — quarterly full epoch (1 Jan/Apr/Jul/Oct)
        '0 2 1 1,4,7,10 * trust_epoch_aggregate',
        // Trust mop-up scoring — Mon/Thu at 02:00 UTC
        '0 2 * * 1,4 trust_epoch_aggregate',
      ].join('\n')
    ),
    taskList: {
      feed_ingest_poll: feedIngestPoll,
      feed_ingest_rss: feedIngestRss,
      feed_ingest_nostr: feedIngestNostr,
      external_items_prune: externalItemsPrune,
      source_metadata_refresh: sourceMetadataRefresh,
      feed_items_reconcile: feedItemsReconcile,
      feed_items_author_refresh: feedItemsAuthorRefresh,
      feed_ingest_atproto_backfill: feedIngestAtprotoBackfill,
      feed_ingest_activitypub: feedIngestActivityPub,
      outbound_cross_post: outboundCrossPost,
      outbound_token_refresh: outboundTokenRefresh,
      atproto_oauth_states_prune: atprotoOauthStatesPrune,
      resolver_results_prune: resolverResultsPrune,
      external_sources_gc: externalSourcesGc,
      feed_scores_refresh: feedScoresRefresh,
      trust_layer1_refresh: trustLayer1Refresh,
      trust_epoch_aggregate: trustEpochAggregate,
    },
  })

  logger.info('Feed ingest worker started')

  // Start the Bluesky Jetstream listener alongside the Graphile runner.
  // It maintains its own WebSocket; nothing to await on startup.
  const jetstream = new JetstreamListener()
  await jetstream.start()

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down feed-ingest worker')
    await jetstream.stop()
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
