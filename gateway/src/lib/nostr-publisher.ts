import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { WebSocket } from 'ws'
import type { SignedNostrEvent } from '@platform-pub/shared/lib/relay-outbox.js'

// =============================================================================
// Gateway Nostr Publisher
//
// Signs events with the platform service key. Publishing to the relay goes
// through `relay_outbox` (see shared/src/lib/relay-outbox.ts) — callers sign
// here and enqueue the result inside their own transaction. `publishToRelay`
// remains for the legacy awaited call sites that Phase 3 of RELAY-OUTBOX-ADR
// will migrate.
//
// Signing uses PLATFORM_SERVICE_PRIVKEY — the same key used by the payment
// service for kind 9901 receipt events.
// =============================================================================

function getServiceKeypair(): { privkey: Uint8Array; pubkey: string } {
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY
  if (!privkeyHex) throw new Error('PLATFORM_SERVICE_PRIVKEY not set')
  const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'))
  const pubkey = getPublicKey(privkey)
  return { privkey, pubkey }
}

// =============================================================================
// Subscription event — kind 7003 (provisional NIP-88)
//
// Signed on subscription create, reactivate, cancel, and renew. Attests that
// reader X has (or had) access to writer Y. Federation use: another host can
// verify this event against GET /platform-pubkey and trust that the
// subscription was valid during the stated period.
//
// NB: This kind number is provisional and will be updated when NIP-88 is
// finalised.
// =============================================================================

interface SubscriptionEventParams {
  subscriptionId: string
  readerPubkey: string
  writerPubkey: string
  status: 'active' | 'cancelled'
  pricePence: number
  periodStart: Date
  periodEnd: Date
}

export function signSubscriptionEvent(params: SubscriptionEventParams): SignedNostrEvent {
  const { privkey } = getServiceKeypair()

  const eventTemplate = {
    kind: 7003,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', params.writerPubkey],
      ['reader', params.readerPubkey],
      ['status', params.status],
      ['amount', String(params.pricePence), 'GBP'],
      ['period_start', String(Math.floor(params.periodStart.getTime() / 1000))],
      ['period_end', String(Math.floor(params.periodEnd.getTime() / 1000))],
      ['subscription', params.subscriptionId],
    ],
    content: '',
  }

  return finalizeEvent(eventTemplate, privkey) as SignedNostrEvent
}

// ---------------------------------------------------------------------------
// Internal relay publisher — identical pattern to payment-service/src/lib/nostr.ts
// ---------------------------------------------------------------------------

export async function publishToRelay(event: ReturnType<typeof finalizeEvent>): Promise<void> {
  const relayUrl = process.env.PLATFORM_RELAY_WS_URL
  if (!relayUrl) throw new Error('PLATFORM_RELAY_WS_URL not set')

  return publishToRelayUrl(relayUrl, event)
}

function publishToRelayUrl(relayUrl: string, event: ReturnType<typeof finalizeEvent>): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Relay publish timeout'))
    }, 5_000)

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]))
    })

    ws.on('message', (data) => {
      try {
        const [type, , success, message] = JSON.parse(data.toString())
        if (type === 'OK') {
          clearTimeout(timeout)
          ws.close()
          if (success) { resolve() } else { reject(new Error(`Relay rejected event: ${message}`)) }
        }
      } catch { /* ignore NOTICE etc */ }
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
