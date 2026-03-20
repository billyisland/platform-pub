import { getNdk, KIND_NOTE } from './ndk'
import { signViaGateway } from './sign'
import { NDKEvent } from '@nostr-dev-kit/ndk'

// =============================================================================
// Note Publishing Service
//
// Publishes a short-form note (Nostr kind 1). Much simpler than the article
// pipeline — no paywall, no vault, no TipTap, no Markdown conversion.
//
// Pipeline:
//   1. Build kind 1 event with plain text content
//   2. Sign via gateway (custodial key)
//   3. Publish to relay
//   4. Index in platform DB via gateway
// =============================================================================

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''

interface PublishNoteResult {
  noteEventId: string
}

export interface QuoteTarget {
  eventId: string
  eventKind: number
  authorPubkey: string
}

export async function publishNote(
  content: string,
  authorPubkey: string,
  quoteTarget?: QuoteTarget
): Promise<PublishNoteResult> {
  const ndk = getNdk()
  await ndk.connect()

  // Build the kind 1 event
  const noteEvent = new NDKEvent(ndk)
  noteEvent.kind = KIND_NOTE
  noteEvent.content = content
  noteEvent.tags = []

  // Add q tag for quote-notes (NIP-18)
  if (quoteTarget) {
    noteEvent.tags.push(['q', quoteTarget.eventId, '', quoteTarget.authorPubkey])
  }

  // Sign via gateway (custodial key)
  const signed = await signViaGateway(noteEvent)

  // Wait for at least one relay to be connected before publishing
  if (ndk.pool.connectedRelays().length === 0) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No relays available — try again in a moment')), 5000)
      const check = () => {
        if (ndk.pool.connectedRelays().length > 0) { clearTimeout(timeout); resolve() }
        else setTimeout(check, 100)
      }
      check()
    })
  }

  // Publish to relay
  await signed.publish()

  // Index in platform DB
  await indexNote({
    nostrEventId: signed.id,
    content,
    ...(quoteTarget && {
      isQuoteComment: true,
      quotedEventId: quoteTarget.eventId,
      quotedEventKind: quoteTarget.eventKind,
    }),
  })

  return { noteEventId: signed.id }
}

// =============================================================================
// Internal helpers
// =============================================================================

async function indexNote(params: {
  nostrEventId: string
  content: string
  isQuoteComment?: boolean
  quotedEventId?: string
  quotedEventKind?: number
}): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/api/v1/notes`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!res.ok) {
    // Non-fatal — the note is on the relay, just not indexed yet
    console.error('Note indexing failed:', res.status)
  }
}
