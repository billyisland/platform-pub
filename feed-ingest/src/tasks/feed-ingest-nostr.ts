import type { Task } from 'graphile-worker'
import { WebSocket } from 'ws'
import { nip19, verifyEvent } from 'nostr-tools'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import logger from '../../shared/src/lib/logger.js'
import { pinnedWebSocketOptions, type PinnedWebSocketOptions } from '../../shared/src/lib/http-client.js'

// Reject events claiming timestamps more than this far in the future — prevents
// a hostile relay from poisoning the cursor into year 2100.
const FUTURE_DRIFT_WINDOW_SECONDS = 10 * 60 // 10 minutes

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

  const expectedPubkey = hexPubkey.toLowerCase()

  try {
    // Fetch events from all relay URLs, deduplicate by event ID
    const eventsMap = new Map<string, NostrEvent>()
    const deletionEvents: NostrEvent[] = []
    let latestProfile: NostrEvent | null = null

    const nowSecs = Math.floor(Date.now() / 1000)
    const maxCreatedAt = nowSecs + FUTURE_DRIFT_WINDOW_SECONDS

    for (const relayUrl of source.relay_urls) {
      try {
        const wsOpts = await pinnedWebSocketOptions(relayUrl)
        const events = await fetchFromRelay(relayUrl, hexPubkey, since, wsOpts)
        for (const event of events) {
          // Reject events claiming timestamps far in the future (cursor poisoning)
          if (event.created_at > maxCreatedAt) {
            logger.warn({ sourceId, relayUrl, eventId: event.id, createdAt: event.created_at },
              'Rejecting Nostr event with future timestamp')
            continue
          }
          // A hostile relay can ship events claiming any pubkey, including
          // the source's own. Verify the signature and the author before
          // treating the payload as authoritative.
          if (event.pubkey?.toLowerCase() !== expectedPubkey) {
            logger.warn({ sourceId, relayUrl, eventId: event.id, eventPubkey: event.pubkey },
              'Rejecting Nostr event: pubkey mismatch')
            continue
          }
          if (!verifyEvent(event as any)) {
            logger.warn({ sourceId, relayUrl, eventId: event.id },
              'Rejecting Nostr event: invalid signature')
            continue
          }
          if (event.kind === 5) {
            deletionEvents.push(event)
          } else if (event.kind === 0) {
            if (!latestProfile || event.created_at > latestProfile.created_at) {
              latestProfile = event
            }
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

    // Cap deletions too — a chatty relay with long delete history can otherwise
    // ship thousands of kind-5s per fetch cycle.
    const cappedDeletes = deletionEvents
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

    // Handle kind 5 deletions. Pubkey + signature were already verified above,
    // so by the time we get here delEvent.pubkey === source.source_uri.
    for (const delEvent of cappedDeletes) {
      const deletedIds = delEvent.tags
        .filter(t => t[0] === 'e')
        .map(t => t[1])

      for (const deletedId of deletedIds) {
        // Match on the raw event id stored in interaction_data — source_item_uri
        // is a nevent that bakes in relay_urls at insert time, so a subsequent
        // relay-list change would silently break URI-based matching.
        await pool.query(
          `UPDATE external_items SET deleted_at = now()
           WHERE source_id = $1 AND protocol = 'nostr_external'
             AND interaction_data->>'id' = $2
             AND deleted_at IS NULL`,
          [sourceId, deletedId]
        )
        await pool.query(
          `UPDATE feed_items SET deleted_at = now()
           WHERE external_item_id IN (
             SELECT id FROM external_items
             WHERE source_id = $1 AND protocol = 'nostr_external'
               AND interaction_data->>'id' = $2
           ) AND deleted_at IS NULL`,
          [sourceId, deletedId]
        )
      }
    }

    // Apply kind-0 profile update if we received a newer one than the stored
    // metadata. Lets readers see the source's latest name/avatar/NIP-05 without
    // waiting for the daily metadata-refresh cron.
    let profileName: string | null | undefined
    let profileAvatar: string | null | undefined
    if (latestProfile) {
      try {
        const profile = JSON.parse(latestProfile.content)
        profileName = typeof profile?.display_name === 'string' ? profile.display_name
                    : typeof profile?.name === 'string' ? profile.name
                    : undefined
        profileAvatar = typeof profile?.picture === 'string' ? profile.picture : undefined
      } catch {
        // Malformed profile — ignore
      }
    }

    // Update source: cursor, reset errors, optionally refresh display metadata.
    await pool.query(`
      UPDATE external_sources SET
        last_fetched_at = now(),
        cursor = $2,
        error_count = 0,
        last_error = NULL,
        display_name = COALESCE($3, display_name),
        avatar_url = COALESCE($4, avatar_url),
        updated_at = now()
      WHERE id = $1
    `, [sourceId, String(newestCreatedAt), profileName ?? null, profileAvatar ?? null])

    if (inserted > 0) {
      logger.info({ sourceId, inserted, total: events.length, deletions: cappedDeletes.length },
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
    `, [sourceId, newErrorCount, errorMessage.slice(0, 1000), shouldDeactivate, Math.round(backoffInterval)])

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

function fetchFromRelay(
  relayUrl: string,
  pubkey: string,
  since: number,
  wsOpts: PinnedWebSocketOptions,
): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = []
    const ws = new WebSocket(relayUrl, wsOpts)
    const subId = `feed-ingest-${Date.now()}`

    const timeout = setTimeout(() => {
      ws.close()
      // Return whatever we have even on timeout
      resolve(events)
    }, 10_000)

    ws.on('open', () => {
      // Kind 0 pulls the latest profile metadata without a `since` filter; the
      // ingest loop keeps only the newest one received. Regular/deletion events
      // use the per-source cursor.
      ws.send(JSON.stringify([
        'REQ', subId,
        {
          kinds: [1, 5, 30023],
          authors: [pubkey],
          since,
        },
        {
          kinds: [0],
          authors: [pubkey],
          limit: 1,
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
