import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { getPlatformConfig } from "../lib/platform-config.js";

// =============================================================================
// feed_ingest_poll — scheduled every 60 seconds
//
// Finds external_sources that are due for polling and enqueues per-source
// fetch jobs. Enforces per-host concurrency limits to be a good citizen.
// =============================================================================

export const feedIngestPoll: Task = async (_payload, helpers) => {
  // Load config values (process-cached, 30s TTL — A5)
  const config = await getPlatformConfig();
  const maxPerHost =
    parseInt(config.get("feed_ingest_max_per_host") ?? "", 10) || 2;
  // Per-tick enqueue cap (audit #1 / C2). This bounds how many fetch jobs the
  // poll enqueues per 60s tick — NOT how many run at once. Actual fetch
  // concurrency is the worker runner's `concurrency` (index.ts) plus the
  // per-source `jobKey` (one in-flight job per source); per-host politeness is
  // `maxPerHost` (≤N/host/tick), preserved below. The two were historically
  // conflated at 10, which capped steady-state throughput at ~10/min ≈ 50
  // sources before they fell behind. Decoupled: default 100 (= the SELECT
  // LIMIT, i.e. enqueue all due sources each tick) so the ceiling is gone.
  //
  // The default is 100 in code, NOT via the `feed_ingest_max_enqueue_per_tick`
  // seed (migration 106): that seed is config-only and absent from schema.sql,
  // so it never lands on a schema.sql-bootstrapped DB (dev initdb / fresh prod)
  // while `_migrations` marks 106 applied — migrate.ts then skips it (audit D1).
  // We must NOT fall back to the legacy `feed_ingest_max_concurrent` (seeded at
  // 10 on existing DBs): that resurrects the very coupling 106 set out to remove
  // and silently pins throughput at 10. Honour an explicit per-tick override if
  // an operator sets one; otherwise 100, unconditionally.
  const maxEnqueuePerTick =
    parseInt(config.get("feed_ingest_max_enqueue_per_tick") ?? "", 10) || 100;
  // atproto sources are normally pushed by the Jetstream listener. Only
  // fall back to polling via getAuthorFeed if the listener has reported
  // itself unhealthy — otherwise we'd duplicate work.
  const jetstreamHealthy = config.get("jetstream_healthy") !== "false";

  // Find sources due for polling
  const { rows: sources } = await pool.query<{
    id: string;
    protocol: string;
    source_uri: string;
    relay_urls: string[] | null;
  }>(
    `
    SELECT id, protocol, source_uri, relay_urls
    FROM external_sources
    WHERE is_active = TRUE
      AND protocol != 'email'
      AND (protocol != 'atproto' OR $1::boolean = FALSE)
      AND (
        last_fetched_at IS NULL
        OR last_fetched_at + (fetch_interval_seconds || ' seconds')::interval <= now()
      )
    ORDER BY last_fetched_at ASC NULLS FIRST
    LIMIT 100
  `,
    [jetstreamHealthy],
  );

  if (sources.length === 0) return;

  // Group by hostname for rate limiting
  // RSS: group by feed URL hostname
  // Nostr: group by first relay URL hostname (rate limit per relay, not per pubkey)
  const byHost = new Map<string, typeof sources>();
  for (const source of sources) {
    let hostname: string;
    if (
      source.protocol === "nostr_external" &&
      source.relay_urls &&
      source.relay_urls.length > 0
    ) {
      try {
        hostname = new URL(source.relay_urls[0]).hostname;
      } catch {
        hostname = source.source_uri;
      }
    } else {
      try {
        hostname = new URL(source.source_uri).hostname;
      } catch {
        hostname = source.source_uri;
      }
    }
    const group = byHost.get(hostname) ?? [];
    group.push(source);
    byHost.set(hostname, group);
  }

  // Enqueue jobs respecting per-host and global limits
  let totalEnqueued = 0;
  for (const [_hostname, hostSources] of byHost) {
    const toEnqueue = hostSources.slice(0, maxPerHost);
    for (const source of toEnqueue) {
      if (totalEnqueued >= maxEnqueuePerTick) break;

      const taskName =
        source.protocol === "rss"
          ? "feed_ingest_rss"
          : source.protocol === "nostr_external"
            ? "feed_ingest_nostr"
            : source.protocol === "activitypub"
              ? "feed_ingest_activitypub"
              : source.protocol === "atproto" && !jetstreamHealthy
                ? "feed_ingest_atproto_backfill"
                : null;
      if (!taskName) continue;

      await helpers.addJob(
        taskName,
        { sourceId: source.id },
        {
          jobKey: `feed_ingest_${source.id}`,
          maxAttempts: 1,
        },
      );
      totalEnqueued++;
    }
    if (totalEnqueued >= maxEnqueuePerTick) break;
  }

  if (totalEnqueued > 0) {
    logger.info({ count: totalEnqueued }, "Enqueued feed ingest jobs");
  }
};
