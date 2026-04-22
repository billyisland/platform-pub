import { finalizeEvent, getPublicKey } from 'nostr-tools'
import type { SignedNostrEvent } from '@platform-pub/shared/lib/relay-outbox.js'

// =============================================================================
// Portable Receipt Token
//
// A private signed Nostr kind 9901 event containing the reader's actual pubkey.
// NOT published to the relay — stored in the DB and exportable by the reader.
// Verifiable offline with verifyEvent() from nostr-tools against the platform
// pubkey returned by GET /platform-pubkey.
//
// The public kind 9901 relay event (signReceiptEvent below) still uses the
// keyed HMAC hash for reader privacy on the public relay.
// =============================================================================

interface PortableReceiptParams {
  articleNostrEventId: string
  writerPubkey: string
  readerPubkey: string    // actual pubkey — only in the private receipt
  amountPence: number
}

// =============================================================================
// Nostr Receipt Signer
//
// Signs kind 9901 consumption receipt events per ADR §II.4b. The caller is
// expected to hand the returned event to relay_outbox
// (`enqueueRelayPublish` in shared) inside a transaction — publishing itself
// lives in the feed-ingest `relay_publish` worker.
//
// The receipt is signed by the platform's service keypair, not the reader's.
// The platform is attesting that the gate was passed and charge recorded.
// =============================================================================

interface ReceiptParams {
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

export function signReceiptEvent(params: ReceiptParams): SignedNostrEvent {
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

  return finalizeEvent(eventTemplate, privkey) as SignedNostrEvent
}
