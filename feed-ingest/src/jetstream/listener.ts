import { WebSocket } from 'ws'
import type { PoolClient } from 'pg'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import logger from '../../shared/src/lib/logger.js'
import { pinnedWebSocketOptions } from '../../shared/src/lib/http-client.js'
import { ADVISORY_LOCKS } from '../../shared/src/lib/advisory-locks.js'
import { normaliseAtprotoCommit, buildAtUri, type JetstreamCommit } from '../adapters/atproto.js'
import { insertAtprotoItem } from '../lib/atproto-ingest.js'

// =============================================================================
// Jetstream listener
//
// A long-lived WebSocket subscriber to the Bluesky Jetstream firehose. See
// UNIVERSAL-FEED-ADR.md §V.3 and §VI.3.
//
// Responsibilities:
//   - Maintain a persistent connection filtered to the set of DIDs we have
//     active external_sources for, and to app.bsky.feed.post events only.
//   - Re-check the DID set every 60s; reconnect with updated filter when it
//     changes. Jetstream does not support dynamic subscription updates.
//   - Persist per-source time_us cursors so restarts resume without gaps.
//   - Dual-write ingested posts into external_items + feed_items in one
//     transaction, using ON CONFLICT DO NOTHING for idempotency.
//   - Set deleted_at on posts that receive a delete commit.
//   - Update platform_config.jetstream_healthy so the RSS-style polling
//     fallback can kick in if the listener is wedged.
//
// Connection lifecycle:
//   - No active DIDs → no connection. Poll loop keeps checking.
//   - New DID appears → connect.
//   - DID set changes while connected → reconnect with new filter.
//   - WebSocket error/close → exponential backoff, reconnect.
// =============================================================================

const DEFAULT_JETSTREAM_URL = 'wss://jetstream1.us-east.bsky.network/subscribe'
const WANTED_COLLECTIONS = ['app.bsky.feed.post']
const DID_REFRESH_INTERVAL_MS = 60_000
const INITIAL_BACKOFF_MS = 1000
// Session-scoped advisory lock key. Only one feed-ingest replica at a time
// runs the Jetstream WebSocket; others poll for the lock. See
// shared/src/lib/advisory-locks.ts for the full registry.
const JETSTREAM_LOCK_KEY = ADVISORY_LOCKS.JETSTREAM
const LEADER_POLL_MS = 30_000

// Jetstream puts every DID in the upgrade URL as a `wantedDids=` query param.
// Most reverse proxies and WebSocket servers cap the upgrade URL around
// 8-16 KB; each DID contributes ~40 bytes (including the param name + `=`
// + URL encoding), so the server filter tops out around 150-200 DIDs. Above
// this we subscribe to the wildcard firehose (still scoped to
// app.bsky.feed.post via wantedCollections) and filter DIDs client-side
// using sourceByDid. Bandwidth goes up but the platform scales past 200
// Bluesky subscriptions without sharding.
const WILDCARD_DID_THRESHOLD = 150

type SourceRow = {
  id: string
  source_uri: string
  cursor: string | null
  display_name: string | null
  avatar_url: string | null
}

export class JetstreamListener {
  private readonly url: string
  private ws: WebSocket | null = null
  private currentDids: Set<string> = new Set()
  private sourceByDid: Map<string, SourceRow> = new Map()
  private reconnectTimer: NodeJS.Timeout | null = null
  private didRefreshTimer: NodeJS.Timeout | null = null
  private backoffMs = INITIAL_BACKOFF_MS
  private maxBackoffMs = 30_000
  private stopping = false
  private healthy = false
  private leaderClient: PoolClient | null = null
  private leaderPollTimer: NodeJS.Timeout | null = null
  private isLeader = false

  constructor(url?: string) {
    this.url = url ?? process.env.JETSTREAM_URL ?? DEFAULT_JETSTREAM_URL
  }

  async start(): Promise<void> {
    logger.info({ url: this.url }, 'Jetstream listener starting')
    await this.loadMaxBackoff()
    // Try to claim leadership immediately; if another replica holds the lock,
    // poll periodically until it's released.
    await this.tryBecomeLeader()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.didRefreshTimer) clearTimeout(this.didRefreshTimer)
    if (this.leaderPollTimer) clearTimeout(this.leaderPollTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
    }
    await this.releaseLeadership()
    await this.setHealthy(false)
    logger.info('Jetstream listener stopped')
  }

  // --- Leader election --------------------------------------------------------
  //
  // Jetstream state (cursor, DID filter) is global; running it on >1 replica
  // produces duplicate ingestion and cursor contention. Use a session-scoped
  // advisory lock: whichever replica holds it is the sole listener. Others
  // poll until the holder dies and releases.

  private async tryBecomeLeader(): Promise<void> {
    if (this.stopping || this.isLeader) return
    let client: PoolClient
    try {
      client = await pool.connect()
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Leader election: pool.connect failed')
      this.schedulePollRetry()
      return
    }
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [JETSTREAM_LOCK_KEY]
      )
      if (rows[0]?.locked) {
        this.leaderClient = client
        this.isLeader = true
        logger.info('Jetstream leader elected — starting listener')
        await this.refreshDids()
        this.scheduleDidRefresh()
        return
      }
      // Lock held elsewhere — release the client and poll again later.
      client.release()
      this.schedulePollRetry()
    } catch (err) {
      try { client.release() } catch { /* ignore */ }
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Leader election attempt failed')
      this.schedulePollRetry()
    }
  }

  private schedulePollRetry(): void {
    if (this.stopping) return
    this.leaderPollTimer = setTimeout(() => {
      this.leaderPollTimer = null
      this.tryBecomeLeader().catch((err) =>
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Leader election poll failed')
      )
    }, LEADER_POLL_MS)
  }

  private async releaseLeadership(): Promise<void> {
    if (!this.leaderClient) return
    try {
      await this.leaderClient.query('SELECT pg_advisory_unlock($1)', [JETSTREAM_LOCK_KEY])
    } catch { /* ignore — the session is going away anyway */ }
    try { this.leaderClient.release() } catch { /* ignore */ }
    this.leaderClient = null
    this.isLeader = false
  }

  // Self-scheduling DID refresh. Using setTimeout (rather than setInterval)
  // guarantees the next tick only fires after the previous one resolves, so a
  // slow DB query cannot stack up overlapping reconnects.
  private scheduleDidRefresh(): void {
    if (this.stopping || !this.isLeader) return
    this.didRefreshTimer = setTimeout(() => {
      this.didRefreshTimer = null
      this.refreshDids()
        .catch((err) => logger.warn({ err: err.message }, 'DID refresh failed'))
        .finally(() => this.scheduleDidRefresh())
    }, DID_REFRESH_INTERVAL_MS)
  }

  private async loadMaxBackoff(): Promise<void> {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'feed_ingest_atproto_reconnect_max_seconds'`
    )
    const parsed = parseInt(rows[0]?.value ?? '30', 10)
    if (!isNaN(parsed) && parsed > 0) this.maxBackoffMs = parsed * 1000
  }

  // --- DID set management -----------------------------------------------------

  private async refreshDids(): Promise<void> {
    const { rows } = await pool.query<SourceRow>(`
      SELECT id, source_uri, cursor, display_name, avatar_url
      FROM external_sources
      WHERE protocol = 'atproto' AND is_active = TRUE
    `)

    const nextDids = new Set<string>()
    const nextMap = new Map<string, SourceRow>()
    for (const row of rows) {
      nextDids.add(row.source_uri)
      nextMap.set(row.source_uri, row)
    }

    const changed = !setsEqual(this.currentDids, nextDids)
    const wasWildcard = this.currentDids.size >= WILDCARD_DID_THRESHOLD
    const willBeWildcard = nextDids.size >= WILDCARD_DID_THRESHOLD
    this.currentDids = nextDids
    this.sourceByDid = nextMap

    if (!changed) return

    // When we were and still are above the wildcard threshold, the Jetstream
    // filter didn't change — we aren't sending `wantedDids` at all. The only
    // thing that matters is `sourceByDid`, which we just swapped in memory.
    // Avoid the full cursor-rewind reconnect storm for routine subscribe /
    // unsubscribe churn past the threshold.
    if (wasWildcard && willBeWildcard && this.ws) {
      logger.info({ didCount: nextDids.size },
        'Jetstream DID set changed (wildcard mode) — filter is client-side, no reconnect')
      return
    }

    logger.info(
      { didCount: nextDids.size, mode: willBeWildcard ? 'wildcard' : 'filtered' },
      'Jetstream DID set changed — reconnecting'
    )

    if (nextDids.size === 0) {
      if (this.ws) this.ws.close()
      this.ws = null
      await this.setHealthy(false)
      return
    }

    // Force a reconnect with the new filter.
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.backoffMs = INITIAL_BACKOFF_MS
    void this.connect()
  }

  // --- Cursor handling --------------------------------------------------------

  // Jetstream's ?cursor= param is time_us (microseconds since epoch). On
  // reconnect, resume from the oldest cursor across active sources so we do
  // not lose events from any source, relying on the unique constraint to
  // dedupe overlap with more recently updated sources.
  private oldestCursor(): string | null {
    let oldest: bigint | null = null
    for (const row of this.sourceByDid.values()) {
      if (!row.cursor) continue
      try {
        const v = BigInt(row.cursor)
        if (oldest === null || v < oldest) oldest = v
      } catch {
        // skip malformed cursors
      }
    }
    return oldest === null ? null : oldest.toString()
  }

  // --- WebSocket connection ---------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopping) return
    if (this.currentDids.size === 0) return

    const params = new URLSearchParams()
    for (const c of WANTED_COLLECTIONS) params.append('wantedCollections', c)

    const wildcard = this.currentDids.size >= WILDCARD_DID_THRESHOLD
    if (!wildcard) {
      // Below threshold: let Jetstream do the DID filter server-side so we
      // only receive events we care about.
      for (const did of this.currentDids) params.append('wantedDids', did)
    }
    // Above threshold: omit `wantedDids` and receive every
    // app.bsky.feed.post. handleMessage() drops events whose DID isn't in
    // sourceByDid, so correctness is unaffected — only bandwidth goes up.

    const cursor = this.oldestCursor()
    if (cursor) params.set('cursor', cursor)

    const fullUrl = `${this.url}?${params.toString()}`
    logger.debug(
      { didCount: this.currentDids.size, mode: wildcard ? 'wildcard' : 'filtered', cursor },
      'Opening Jetstream WebSocket'
    )

    // Pin the resolved IP so the WS library can't be tricked by a second
    // DNS lookup into connecting to a different (private) address — same
    // defense undici gets from buildPinnedAgent. Failure here (DNS error,
    // private-IP resolution) is logged and treated as a transient error;
    // the reconnect backoff loop will try again.
    let wsOpts
    try {
      wsOpts = await pinnedWebSocketOptions(fullUrl)
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) },
        'Jetstream pinned WS resolution failed — will retry after backoff')
      if (!this.stopping) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          void this.connect()
        }, this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
      }
      return
    }
    // DID set or stop flag may have changed while we awaited DNS.
    if (this.stopping || this.currentDids.size === 0) return

    const ws = new WebSocket(fullUrl, wsOpts)
    this.ws = ws

    ws.on('open', () => {
      this.backoffMs = INITIAL_BACKOFF_MS
      this.setHealthy(true).catch(() => {})
      logger.info({ didCount: this.currentDids.size }, 'Jetstream connected')
    })

    ws.on('message', (data) => {
      this.handleMessage(data.toString()).catch((err) =>
        logger.warn({ err: err.message }, 'Jetstream message handling failed')
      )
    })

    ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'Jetstream WebSocket error')
    })

    ws.on('close', (code) => {
      this.ws = null
      this.setHealthy(false).catch(() => {})
      if (this.stopping) return
      logger.info({ code, backoffMs: this.backoffMs }, 'Jetstream closed — scheduling reconnect')
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.connect()
      }, this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
    })
  }

  // --- Event handling ---------------------------------------------------------

  private async handleMessage(raw: string): Promise<void> {
    let event: JetstreamCommit
    try {
      event = JSON.parse(raw)
    } catch {
      return
    }

    if (event.kind !== 'commit') return
    if (!event.commit) return
    if (event.commit.collection !== 'app.bsky.feed.post') return

    const source = this.sourceByDid.get(event.did)
    if (!source) return // post by a DID we no longer subscribe to; ignore

    if (event.commit.operation === 'delete') {
      await this.handleDelete(source.id, event.did, event.commit.rkey, event.time_us)
      return
    }

    const item = normaliseAtprotoCommit(event)
    if (!item) return

    await this.ingest(source, item, event.time_us)
  }

  private async ingest(
    source: SourceRow,
    item: ReturnType<typeof normaliseAtprotoCommit> & {},
    timeUs: number
  ): Promise<void> {
    try {
      await withTransaction(async (client) => {
        await insertAtprotoItem(client, source, item)
      })

      // Advance this source's cursor. Use max(existing, timeUs) so
      // out-of-order delivery does not regress the cursor.
      await pool.query(`
        UPDATE external_sources
        SET cursor = GREATEST(COALESCE(cursor::BIGINT, 0), $2)::TEXT,
            last_fetched_at = now(),
            error_count = 0,
            last_error = NULL,
            updated_at = now()
        WHERE id = $1
      `, [source.id, timeUs])

      // Keep in-memory source cursor in sync for oldestCursor() on reconnect.
      // Mirror the DB's GREATEST guard: Jetstream can deliver out-of-order
      // (e.g. after a reconnect that resumed from an older cursor), and we
      // must not regress and re-admit already-ingested events.
      const existing = source.cursor ? BigInt(source.cursor) : 0n
      if (BigInt(timeUs) > existing) source.cursor = String(timeUs)
    } catch (err) {
      logger.warn(
        { sourceId: source.id, uri: item.sourceItemUri, err: err instanceof Error ? err.message : String(err) },
        'Failed to ingest atproto item'
      )
    }
  }

  private async handleDelete(sourceId: string, did: string, rkey: string, timeUs: number): Promise<void> {
    const uri = buildAtUri(did, 'app.bsky.feed.post', rkey)
    try {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE external_items SET deleted_at = now()
           WHERE source_id = $1 AND protocol = 'atproto' AND source_item_uri = $2
             AND deleted_at IS NULL`,
          [sourceId, uri]
        )
        await client.query(
          `UPDATE feed_items SET deleted_at = now()
           WHERE source_id = $1 AND source_protocol = 'atproto' AND source_item_uri = $2
             AND deleted_at IS NULL`,
          [sourceId, uri]
        )
      })
      await pool.query(
        `UPDATE external_sources
         SET cursor = GREATEST(COALESCE(cursor::BIGINT, 0), $2)::TEXT,
             updated_at = now()
         WHERE id = $1`,
        [sourceId, timeUs]
      )
    } catch (err) {
      logger.warn(
        { sourceId, uri, err: err instanceof Error ? err.message : String(err) },
        'Failed to apply atproto delete'
      )
    }
  }

  // --- Health flag ------------------------------------------------------------

  private async setHealthy(healthy: boolean): Promise<void> {
    if (this.healthy === healthy) return
    this.healthy = healthy
    try {
      await pool.query(
        `UPDATE platform_config SET value = $1, updated_at = now() WHERE key = 'jetstream_healthy'`,
        [healthy ? 'true' : 'false']
      )
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to write jetstream_healthy flag')
    }
  }
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}
