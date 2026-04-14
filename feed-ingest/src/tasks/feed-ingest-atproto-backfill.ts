import type { Task } from 'graphile-worker'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { safeFetch } from '../../shared/src/lib/http-client.js'
import logger from '../../shared/src/lib/logger.js'
import { normaliseAtprotoPost, type BskyPostRecord } from '../adapters/atproto.js'
import { insertAtprotoItem } from '../lib/atproto-ingest.js'

// =============================================================================
// feed_ingest_atproto_backfill — one-time backfill for a new Bluesky source.
//
// The Jetstream listener only sees posts published after it picks up the DID
// on its next 60s DID-refresh poll. This task fetches recent history via the
// AppView's app.bsky.feed.getAuthorFeed and writes it into external_items +
// feed_items, so a fresh subscription has content immediately rather than
// appearing empty until the author posts again.
//
// Runs once per subscription (enqueued from the subscribe endpoint). Duplicate
// or re-run invocations are safe — the ON CONFLICT DO NOTHING in the ingest
// writer dedupes against anything the listener has already captured.
// =============================================================================

const APPVIEW = 'https://public.api.bsky.app'
const PAGE_LIMIT = 100

interface FeedViewPost {
  post: {
    uri: string
    cid: string
    author: { did: string; handle: string; displayName?: string; avatar?: string }
    record: BskyPostRecord
    indexedAt: string
  }
  reason?: { $type: string } // e.g. reasonRepost — skip these
}

interface AuthorFeedResponse {
  cursor?: string
  feed: FeedViewPost[]
}

export const feedIngestAtprotoBackfill: Task = async (payload, _helpers) => {
  const { sourceId } = payload as { sourceId: string }

  const { rows: [source] } = await pool.query<{
    id: string
    source_uri: string
    display_name: string | null
    avatar_url: string | null
  }>(`SELECT id, source_uri, display_name, avatar_url
      FROM external_sources
      WHERE id = $1 AND protocol = 'atproto' AND is_active = TRUE`, [sourceId])

  if (!source) {
    logger.warn({ sourceId }, 'atproto source not found for backfill — skipping')
    return
  }

  const { rows: [cfgRow] } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = 'feed_ingest_atproto_backfill_hours'`
  )
  const lookbackHours = parseInt(cfgRow?.value ?? '24', 10)
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000

  let cursor: string | undefined
  let inserted = 0
  let seen = 0
  // Hard cap on pages so a pathological actor can't trap the worker.
  const MAX_PAGES = 5

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed`)
      url.searchParams.set('actor', source.source_uri)
      url.searchParams.set('limit', String(PAGE_LIMIT))
      url.searchParams.set('filter', 'posts_no_replies')
      if (cursor) url.searchParams.set('cursor', cursor)

      const res = await safeFetch(url.toString(), {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        logger.warn({ sourceId, status: res.status }, 'getAuthorFeed failed — ending backfill')
        break
      }

      const data = JSON.parse(res.text) as AuthorFeedResponse
      if (!data.feed || data.feed.length === 0) break

      let reachedCutoff = false
      for (const entry of data.feed) {
        seen++
        // Skip reposts in backfill — they're handled via the listener's
        // real-time feed once we ingest repost records (future work).
        if (entry.reason) continue
        const post = entry.post
        if (!post?.record || post.record.$type !== 'app.bsky.feed.post') continue

        const publishedAt = Date.parse(post.record.createdAt) || Date.parse(post.indexedAt) || Date.now()
        if (publishedAt < cutoff) {
          reachedCutoff = true
          continue
        }

        const item = normaliseAtprotoPost({
          did: post.author.did,
          uri: post.uri,
          cid: post.cid,
          record: post.record,
          fallbackDate: new Date(publishedAt),
        })

        try {
          const didInsert = await withTransaction(async (client) => {
            return insertAtprotoItem(client, source, item)
          })
          if (didInsert) inserted++
        } catch (err) {
          logger.warn(
            { sourceId, uri: post.uri, err: err instanceof Error ? err.message : String(err) },
            'atproto backfill insert failed'
          )
        }
      }

      if (reachedCutoff) break
      if (!data.cursor) break
      cursor = data.cursor
    }

    // Bump last_fetched_at so the poll-fallback scheduler respects the
    // fetch_interval_seconds cadence when Jetstream is unhealthy. The
    // listener also updates this column on every real-time event, so a
    // healthy source stays "recent" without hitting this path.
    await pool.query(`
      UPDATE external_sources
      SET last_fetched_at = now(),
          error_count = 0,
          last_error = NULL,
          updated_at = now()
      WHERE id = $1
    `, [sourceId])

    if (inserted > 0 || seen > 0) {
      logger.info({ sourceId, inserted, seen, lookbackHours }, 'atproto backfill complete')
    }
  } catch (err) {
    logger.warn(
      { sourceId, err: err instanceof Error ? err.message : String(err) },
      'atproto backfill failed'
    )
  }
}
