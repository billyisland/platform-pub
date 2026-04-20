import { WebSocket } from 'ws'
import logger from '@platform-pub/shared/lib/logger.js'
import { pinnedWebSocketOptions } from '@platform-pub/shared/lib/http-client.js'

// =============================================================================
// External Nostr outbound adapter
//
// The user's signed event was already produced gateway-side (by key-custody,
// using the user's custodial private key) and stored in outbound_posts.signed_event.
// The job's only responsibility is to push that event onto the source's relay
// URLs. Returns the original event id on success; throws if every relay rejects
// or times out.
// =============================================================================

export interface NostrSignedEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

const RELAY_TIMEOUT_MS = 5_000

export async function publishNostrToRelays(
  event: NostrSignedEvent,
  relayUrls: string[]
): Promise<string> {
  if (relayUrls.length === 0) throw new Error('No relay URLs to publish to')

  const results = await Promise.allSettled(
    relayUrls.map(url => publishOne(url, event))
  )

  let succeeded = 0
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled') {
      succeeded++
    } else {
      logger.warn(
        { relayUrl: relayUrls[i], eventId: event.id, err: r.reason?.message ?? String(r.reason) },
        'Outbound Nostr relay publish failed'
      )
    }
  }

  if (succeeded === 0) throw new Error('All relays rejected or timed out')
  return event.id
}

async function publishOne(relayUrl: string, event: NostrSignedEvent): Promise<void> {
  const wsOpts = await pinnedWebSocketOptions(relayUrl)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl, wsOpts)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Relay publish timeout'))
    }, RELAY_TIMEOUT_MS)

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]))
    })
    ws.on('message', (data) => {
      try {
        const [type, , success, message] = JSON.parse(data.toString())
        if (type === 'OK') {
          clearTimeout(timeout)
          ws.close()
          if (success) resolve()
          else reject(new Error(`Relay rejected event: ${message}`))
        }
      } catch { /* ignore non-OK frames */ }
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
