import { getNdk, KIND_NOTE } from './ndk'
import { signViaGateway } from './sign'
import { NDKEvent } from '@nostr-dev-kit/ndk'

// =============================================================================
// Comment Publishing Service
//
// Publishes a comment as a Nostr kind 1 event with e and p tags referencing
// the parent content. Then indexes via the gateway.
//
// Pipeline:
//   1. Build kind 1 event with e tag (target) and p tag (target author)
//   2. If replying, add second e tag for parent comment
//   3. Sign via gateway (custodial key)
//   4. Publish to relay
//   5. Index via POST /api/v1/comments
// =============================================================================

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''

interface PublishCommentParams {
  content: string
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  parentCommentId?: string
  parentCommentEventId?: string
}

interface PublishCommentResult {
  commentEventId: string
  commentId: string
}

export async function publishComment(params: PublishCommentParams): Promise<PublishCommentResult> {
  const ndk = getNdk()
  await ndk.connect()

  // Build the kind 1 comment event
  const commentEvent = new NDKEvent(ndk)
  commentEvent.kind = KIND_NOTE
  commentEvent.content = params.content
  commentEvent.tags = [
    ['e', params.targetEventId, '', 'root'],
    ['p', params.targetAuthorPubkey],
  ]

  // If replying to another comment, add a reply e tag
  if (params.parentCommentEventId) {
    commentEvent.tags.push(['e', params.parentCommentEventId, '', 'reply'])
  }

  // Sign via gateway (custodial key)
  const signed = await signViaGateway(commentEvent)

  // Publish to relay
  await signed.publish()

  // Index in platform DB
  const indexResult = await indexComment({
    nostrEventId: signed.id,
    targetEventId: params.targetEventId,
    targetKind: params.targetKind,
    parentCommentId: params.parentCommentId ?? null,
    content: params.content,
  })

  return {
    commentEventId: signed.id,
    commentId: indexResult.commentId,
  }
}

async function indexComment(params: {
  nostrEventId: string
  targetEventId: string
  targetKind: number
  parentCommentId: string | null
  content: string
}): Promise<{ commentId: string }> {
  const res = await fetch(`${GATEWAY_URL}/api/v1/comments`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(`Comment indexing failed: ${res.status} — ${body?.error ?? 'unknown'}`)
  }

  const data = await res.json()
  return { commentId: data.commentId ?? data.id ?? '' }
}
