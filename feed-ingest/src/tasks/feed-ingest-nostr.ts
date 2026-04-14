import type { Task } from 'graphile-worker'
import { WebSocket } from 'ws'
import { nip19 } from 'nostr-tools'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// feed_ingest_nostr — per-source external Nostr relay fetch job
//
// Opens temporary WebSocket connections to the source's relay URLs, sends a
// REQ for recent events by the source pubkey, normalises into external_items
// + feed_items, and handles kind 5 deletions.
//
// See UNIVERSAL-FEED-ADR.md §VI.2 for full spec.
// =============================================================================

interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

const DEFAULT_LOOKBACK_SECONDS = 48 * 60 * 60 // 48 hours

export const feedIngestNostr: Task = async (payload, _helpers) => {
  const { sourceId } = payload as { sourceId: string }

  // Load source
  const { rows: [source] } = await pool.query<{
    id: string
    source_uri: string
    relay_urls: string[] | null
    cursor: string | null
    error_count: number
    display_name: string | null
    avatar_url: string | null
  }>(`SELECT id, source_uri, relay_urls, cursor, error_count, display_name, avatar_url
      FROM external_sources WHERE id = $1`, [sourceId])

  if (!source) {
    logger.warn({ sourceId }, 'Nostr source not found — skipping')
    return
  }

  if (!source.relay_urls || source.relay_urls.length === 0) {
    logger.warn({ sourceId }, 'Nostr source has no relay URLs — skipping')
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

  // Parse cursor (created_at timestamp in seconds)
  const since = source.cursor
    ? parseInt(source.cursor, 10)
    : Math.floor(Date.now() / 1000) - DEFAULT_LOOKBACK_SECONDS

  const hexPubkey = source.source_uri

  try {
    // Fetch events from all relay URLs, deduplicate by event ID
    const eventsMap = new Map<string, NostrEvent>()
    const deletionEvents: NostrEvent[] = []

    for (const relayUrl of source.relay_urls) {
      try {
        const events = await fetchFromRelay(relayUrl, hexPubkey, since)
        for (const event of events) {
          if (event.kind === 5) {
            deletionEvents.push(event)
          } else {
            eventsMap.set(event.id, event)
          }
        }
      } catch (err) {
        logger.warn({ sourceId, relayUrl, err: err instanceof Error ? err.message : String(err) },
          'Failed to fetch from relay — trying next')
      }
    }

    // Sort by created_at DESC, cap at maxItems
    const events = [...eventsMap.values()]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, maxItems)

    // Upsert events into external_items + feed_items
    let inserted = 0
    let newestCreatedAt = since

    for (const event of events) {
      const normalised = normaliseNostrEvent(event, source.relay_urls!)
      const didInsert = await withTransaction(async (client) => {
        const { rowCount, rows } = await client.query<{ id: string }>(`
          INSERT INTO external_items (
            source_id, protocol, tier,
            source_item_uri, author_name, author_handle,
            content_text, title,
            media, published_at,
            source_reply_uri, interaction_data
          ) VALUES (
            $1, 'nostr_external', 'tier2',
            $2, $3, $4,
            $5, $6,
            '[]', to_timestamp($7),
            $8, $9
          )
          ON CONFLICT (protocol, source_item_uri) DO NOTHING
          RETURNING id
        `, [
          sourceId,
          normalised.sourceItemUri,
          normalised.authorName ?? source.display_name ?? 'Unknown',
          normalised.authorHandle,
          normalised.contentText,
          normalised.title,
          event.created_at,
          normalised.sourceReplyUri,
          JSON.stringify(normalised.interactionData),
        ])

        if (!rowCount || rowCount === 0) return false

        // Dual-write: insert feed_items row
        await client.query(`
          INSERT INTO feed_items (
            item_type, external_item_id,
            author_name, author_avatar,
            title, content_preview,
            tier, published_at,
            source_protocol, source_item_uri, source_id
          ) VALUES (
            'external', $1,
            $2, $3,
            $4, $5,
            'tier2', to_timestamp($6),
            'nostr_external', $7, $8
          )
          ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING
        `, [
          rows[0].id,
          normalised.authorName ?? source.display_name ?? 'Unknown',
          source.avatar_url,
          normalised.title,
          (normalised.contentText ?? '').slice(0, 200),
          event.created_at,
          normalised.sourceItemUri,
          sourceId,
        ])

        return true
      })

      if (didInsert) inserted++
      if (event.created_at > newestCreatedAt) newestCreatedAt = event.created_at
    }

    // Handle kind 5 deletions
    for (const delEvent of deletionEvents) {
      const deletedIds = delEvent.tags
        .filter(t => t[0] === 'e')
        .map(t => t[1])

      for (const deletedId of deletedIds) {
        // Build the nevent URI to match against source_item_uri
        const neventUri = nip19.neventEncode({ id: deletedId, relays: source.relay_urls! })
        await pool.query(
          `UPDATE external_items SET deleted_at = now()
           WHERE source_id = $1 AND protocol = 'nostr_external' AND source_item_uri = $2
             AND deleted_at IS NULL`,
          [sourceId, neventUri]
        )
        await pool.query(
          `UPDATE feed_items SET deleted_at = now()
           WHERE external_item_id IN (
             SELECT id FROM external_items
             WHERE source_id = $1 AND protocol = 'nostr_external' AND source_item_uri = $2
           ) AND deleted_at IS NULL`,
          [sourceId, neventUri]
        )
      }
    }

    // Update source: cursor, reset errors
    await pool.query(`
      UPDATE external_sources SET
        last_fetched_at = now(),
        cursor = $2,
        error_count = 0,
        last_error = NULL,
        updated_at = now()
      WHERE id = $1
    `, [sourceId, String(newestCreatedAt)])

    if (inserted > 0) {
      logger.info({ sourceId, inserted, total: events.length, deletions: deletionEvents.length },
        'Nostr events ingested')
    }

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const newErrorCount = source.error_count + 1
    const shouldDeactivate = newErrorCount >= maxErrors
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
    `, [sourceId, newErrorCount, errorMessage, shouldDeactivate, Math.round(backoffInterval)])

    if (shouldDeactivate) {
      logger.warn({ sourceId, errorCount: newErrorCount }, 'Nostr source deactivated after too many errors')
    } else {
      logger.warn({ sourceId, errorCount: newErrorCount, err: errorMessage }, 'Nostr fetch failed')
    }
  }
}

// =============================================================================
// Fetch events from a single Nostr relay
// =============================================================================

function fetchFromRelay(relayUrl: string, pubkey: string, since: number): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = []
    const ws = new WebSocket(relayUrl)
    const subId = `feed-ingest-${Date.now()}`

    const timeout = setTimeout(() => {
      ws.close()
      // Return whatever we have even on timeout
      resolve(events)
    }, 10_000)

    ws.on('open', () => {
      ws.send(JSON.stringify([
        'REQ', subId,
        {
          kinds: [1, 5, 30023],
          authors: [pubkey],
          since,
        },
      ]))
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          events.push(msg[2] as NostrEvent)
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          clearTimeout(timeout)
          ws.send(JSON.stringify(['CLOSE', subId]))
          ws.close()
          resolve(events)
        }
      } catch {
        // Ignore parse errors
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    ws.on('close', () => {
      clearTimeout(timeout)
      resolve(events)
    })
  })
}

// =============================================================================
// Normalise a Nostr event into external_items fields
// =============================================================================

interface NormalisedNostrItem {
  sourceItemUri: string
  authorName: string | null
  authorHandle: string | null
  contentText: string
  title: string | null
  sourceReplyUri: string | null
  interactionData: { id: string; pubkey: string; relays: string[] }
}

function normaliseNostrEvent(event: NostrEvent, relayUrls: string[]): NormalisedNostrItem {
  // NIP-19 nevent encoding for source_item_uri
  const sourceItemUri = nip19.neventEncode({ id: event.id, relays: relayUrls })

  // Extract reply target (NIP-10: last 'e' tag with 'reply' marker, or last 'e' tag)
  let sourceReplyUri: string | null = null
  const eTags = event.tags.filter(t => t[0] === 'e')
  const replyTag = eTags.find(t => t[3] === 'reply') ?? (eTags.length > 0 ? eTags[eTags.length - 1] : null)
  if (replyTag) {
    sourceReplyUri = nip19.neventEncode({
      id: replyTag[1],
      relays: replyTag[2] ? [replyTag[2]] : relayUrls,
    })
  }

  // For kind 30023 (long-form), extract title from tags
  let title: string | null = null
  if (event.kind === 30023) {
    const titleTag = event.tags.find(t => t[0] === 'title')
    title = titleTag ? titleTag[1] : null
  }

  return {
    sourceItemUri,
    authorName: null, // Populated from source display_name
    authorHandle: null,
    contentText: event.content,
    title,
    sourceReplyUri,
    interactionData: {
      id: event.id,
      pubkey: event.pubkey,
      relays: relayUrls,
    },
  }
}
