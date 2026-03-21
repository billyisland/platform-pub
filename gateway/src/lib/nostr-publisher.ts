import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { WebSocket } from 'ws'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Gateway Nostr Publisher
//
// Signs events with the platform service key and publishes them to the relay.
// Used for subscription state events (kind 7003) and any other platform-attested
// Nostr events originating from the gateway.
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
// Published on subscription create, reactivate, and cancel. Signed by the
// platform service key to attest that reader X has (or had) access to writer Y.
//
// Federation use: another host can verify this event against GET /platform-pubkey
// and trust that the subscription was valid during the stated period.
//
// NB: This kind number is provisional and will be updated when NIP-88 is
// finalised. Implementations should treat the kind as an opaque platform
// extension until the NIP stabilises.
// =============================================================================

export interface SubscriptionEventParams {
  subscriptionId: string
  readerPubkey: string
  writerPubkey: string
  status: 'active' | 'cancelled'
  pricePence: number
  periodStart: Date
  periodEnd: Date
}

export async function publishSubscriptionEvent(params: SubscriptionEventParams): Promise<string> {
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

  const signedEvent = finalizeEvent(eventTemplate, privkey)
  await publishToRelay(signedEvent)

  logger.debug(
    { nostrEventId: signedEvent.id, subscriptionId: params.subscriptionId, status: params.status },
    'Subscription Nostr event published'
  )

  return signedEvent.id
}

// ---------------------------------------------------------------------------
// Internal relay publisher — identical pattern to payment-service/src/lib/nostr.ts
// ---------------------------------------------------------------------------

async function publishToRelay(event: ReturnType<typeof finalizeEvent>): Promise<void> {
  const relayUrl = process.env.PLATFORM_RELAY_WS_URL
  if (!relayUrl) throw new Error('PLATFORM_RELAY_WS_URL not set')

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
          success ? resolve() : reject(new Error(`Relay rejected event: ${message}`))
        }
      } catch { /* ignore NOTICE etc */ }
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
