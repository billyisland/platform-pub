import { finalizeEvent, getPublicKey } from 'nostr-tools'
import logger from './logger.js'

// =============================================================================
// Portable Receipt Token
//
// A private signed Nostr kind 9901 event containing the reader's actual pubkey.
// NOT published to the relay — stored in the DB and exportable by the reader.
// Verifiable offline with verifyEvent() from nostr-tools against the platform
// pubkey returned by GET /platform-pubkey.
//
// The public kind 9901 relay event (publishReceiptEvent below) still uses the
// keyed HMAC hash for reader privacy on the public relay.
// =============================================================================

export interface PortableReceiptParams {
  articleNostrEventId: string
  writerPubkey: string
  readerPubkey: string    // actual pubkey — only in the private receipt
  amountPence: number
}

// =============================================================================
// Nostr Receipt Publisher
//
// Publishes kind 9901 consumption receipt events per ADR §II.4b.
//
// This is NOT in the critical payment path — DB write always happens first.
// Receipt publish failures are logged and queued for retry; they never block
// content delivery or payment recording.
//
// The receipt is signed by the platform's service keypair, not the reader's.
// The platform is attesting that the gate was passed and charge recorded.
// =============================================================================

interface ReceiptParams {
  readEventId: string
  articleNostrEventId: string
  writerPubkey: string
  readerPubkeyHash: string | null
  amountPence: number
  tabId: string
}

// Platform service keypair — loaded from env, not generated at runtime
function getServiceKeypair(): { privkey: Uint8Array; pubkey: string } {
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY
  if (!privkeyHex) throw new Error('PLATFORM_SERVICE_PRIVKEY not set')

  const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'))
  const pubkey = getPublicKey(privkey)
  return { privkey, pubkey }
}

// Creates and signs a portable receipt event. Does not publish to relay.
// Returns the full JSON string of the signed event.
export function createPortableReceipt(params: PortableReceiptParams): string {
  const { privkey } = getServiceKeypair()

  const eventTemplate = {
    kind: 9901,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', params.articleNostrEventId],
      ['p', params.writerPubkey],
      ['reader', params.readerPubkey],   // actual pubkey — private receipt only
      ['amount', String(params.amountPence), 'GBP'],
      ['gate', 'passed'],
    ],
    content: '',
  }

  const signedEvent = finalizeEvent(eventTemplate, privkey)
  return JSON.stringify(signedEvent)
}

export async function publishReceiptEvent(params: ReceiptParams): Promise<string> {
  const { privkey } = getServiceKeypair()

  const eventTemplate = {
    kind: 9901,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', params.articleNostrEventId],
      ['p', params.writerPubkey],
      ...(params.readerPubkeyHash ? [['reader', params.readerPubkeyHash]] : []),
      ['amount', String(params.amountPence), 'GBP'],
      ['tab', params.tabId],
      ['gate', 'passed'],
      ['ts', String(Math.floor(Date.now() / 1000))],
    ],
    content: '',
  }

  const signedEvent = finalizeEvent(eventTemplate, privkey)

  await publishToRelay(signedEvent)

  logger.debug({ nostrEventId: signedEvent.id, readEventId: params.readEventId }, 'Receipt event published')

  return signedEvent.id
}

async function publishToRelay(event: ReturnType<typeof finalizeEvent>): Promise<void> {
  const relayUrl = process.env.PLATFORM_RELAY_WS_URL
  if (!relayUrl) throw new Error('PLATFORM_RELAY_WS_URL not set')

  // Simple WebSocket publish — production would use a pooled relay connection
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Relay publish timeout'))
    }, 5_000)

    ws.onopen = () => {
      ws.send(JSON.stringify(['EVENT', event]))
    }

    ws.onmessage = (msg) => {
      try {
        const [type, eventId, success, message] = JSON.parse(msg.data as string)
        if (type === 'OK') {
          clearTimeout(timeout)
          ws.close()
          if (success) {
            resolve()
          } else {
            reject(new Error(`Relay rejected event: ${message}`))
          }
        }
      } catch {
        // Non-OK messages (NOTICE etc) — ignore
      }
    }

    ws.onerror = (err) => {
      clearTimeout(timeout)
      reject(err)
    }
  })
}
