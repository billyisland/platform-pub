import { signPublishAndIndex } from './signPublishAndIndex'

// =============================================================================
// Comment Publishing Service
//
// Publishes a comment as a Nostr kind 1 event via the gateway, then indexes.
// =============================================================================

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
  const tags: string[][] = [
    ['e', params.targetEventId, '', 'root'],
    ['p', params.targetAuthorPubkey],
  ]

  if (params.parentCommentEventId) {
    tags.push(['e', params.parentCommentEventId, '', 'reply'])
  }

  const result = await signPublishAndIndex({
    content: params.content,
    tags,
    indexEndpoint: '/api/v1/comments',
    indexBody: (eventId) => ({
      nostrEventId: eventId,
      targetEventId: params.targetEventId,
      targetKind: params.targetKind,
      parentCommentId: params.parentCommentId ?? null,
      content: params.content,
    }),
  })

  return {
    commentEventId: result.eventId,
    commentId: result.indexData.commentId as string ?? result.indexData.id as string ?? '',
  }
}
