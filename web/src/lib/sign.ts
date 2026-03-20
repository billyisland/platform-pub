import { NDKEvent } from '@nostr-dev-kit/ndk'

// =============================================================================
// Signing Utility
//
// Signs a Nostr event template via the gateway's custodial signing service.
// Shared by the article publishing pipeline (publish.ts) and the note
// publishing pipeline (publishNote.ts).
//
// The gateway decrypts the user's custodial private key, signs the event,
// and returns the fully populated event (id, pubkey, sig, created_at).
// =============================================================================

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''

export async function signViaGateway(event: NDKEvent): Promise<NDKEvent> {
  const res = await fetch(`${GATEWAY_URL}/api/v1/sign`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: event.kind,
      content: event.content,
      tags: event.tags,
    }),
  })

  if (!res.ok) {
    throw new Error(`Event signing failed: ${res.status}`)
  }

  const signedData = await res.json()
  event.id = signedData.id
  event.sig = signedData.sig
  event.pubkey = signedData.pubkey
  event.created_at = signedData.created_at

  return event
}
