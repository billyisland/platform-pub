import { getNdk, KIND_NOTE } from './ndk'
import { signViaGateway } from './sign'
import { NDKEvent } from '@nostr-dev-kit/ndk'

// =============================================================================
// Reply Publishing Service
//
// Publishes a reply as a Nostr kind 1 event with e and p tags referencing
// the parent content. Then indexes via the gateway.
//
// Pipeline:
//   1. Build kind 1 event with e tag (target) and p tag (target author)
//   2. If replying to another reply, add second e tag for parent
//   3. Sign via gateway (custodial key)
//   4. Publish to relay
//   5. Index via POST /api/v1/replies
// =============================================================================

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''

interface PublishReplyParams {
  content: string
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  parentCommentId?: string
  parentCommentEventId?: string
}

interface PublishReplyResult {
  replyEventId: string
  replyId: string
}

export async function publishReply(params: PublishReplyParams): Promise<PublishReplyResult> {
  const ndk = getNdk()
  await ndk.connect()

  // Build the kind 1 reply event
  const replyEvent = new NDKEvent(ndk)
  replyEvent.kind = KIND_NOTE
  replyEvent.content = params.content
  replyEvent.tags = [
    ['e', params.targetEventId, '', 'root'],
    ['p', params.targetAuthorPubkey],
  ]

  // If replying to another reply, add a reply e tag
  if (params.parentCommentEventId) {
    replyEvent.tags.push(['e', params.parentCommentEventId, '', 'reply'])
  }

  // Sign via gateway (custodial key)
  const signed = await signViaGateway(replyEvent)

  // Publish to relay
  await signed.publish()

  // Index in platform DB
  const indexResult = await indexReply({
    nostrEventId: signed.id,
    targetEventId: params.targetEventId,
    targetKind: params.targetKind,
    parentCommentId: params.parentCommentId ?? null,
    content: params.content,
  })

  return {
    replyEventId: signed.id,
    replyId: indexResult.replyId,
  }
}

async function indexReply(params: {
  nostrEventId: string
  targetEventId: string
  targetKind: number
  parentCommentId: string | null
  content: string
}): Promise<{ replyId: string }> {
  const res = await fetch(`${GATEWAY_URL}/api/v1/replies`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(`Reply indexing failed: ${res.status} — ${body?.error ?? 'unknown'}`)
  }

  const data = await res.json()
  return { replyId: data.commentId ?? data.id ?? '' }
}
