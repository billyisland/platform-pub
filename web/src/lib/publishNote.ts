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

export async function publishNote(
  content: string,
  authorPubkey: string
): Promise<PublishNoteResult> {
  const ndk = getNdk()
  await ndk.connect()

  // Build the kind 1 event
  const noteEvent = new NDKEvent(ndk)
  noteEvent.kind = KIND_NOTE
  noteEvent.content = content
  noteEvent.tags = []

  // Sign via gateway (custodial key)
  const signed = await signViaGateway(noteEvent)

  // Publish to relay
  await signed.publish()

  // Index in platform DB
  await indexNote({
    nostrEventId: signed.id,
    content,
  })

  return { noteEventId: signed.id }
}

// =============================================================================
// Internal helpers
// =============================================================================

async function indexNote(params: {
  nostrEventId: string
  content: string
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
