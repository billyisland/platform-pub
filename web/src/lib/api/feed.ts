import { request } from './client'

export type FeedReach = 'following' | 'explore'

export const feed = {
  get: (reach: FeedReach, cursor?: number, limit?: number) =>
    request<{ items: any[]; reach: FeedReach }>(
      `/feed?reach=${reach}${cursor ? `&cursor=${cursor}` : ''}${limit ? `&limit=${limit}` : ''}`
    ),
}

// =============================================================================
// Replies
// =============================================================================

export interface ReplyResponse {
  comments: any[]
  totalCount: number
  repliesEnabled: boolean
  commentsEnabled: boolean // backwards-compat alias
  paywallLocked?: boolean
}

// =============================================================================
// Conversation (in-place neighbourhood: ancestors above + descendants below)
// =============================================================================

export interface ConversationNode {
  eventId: string
  commentId: string | null
  parentEventId: string | null
  kind: number
  isRoot: boolean
  author: {
    id: string
    username: string | null
    displayName: string | null
    avatar: string | null
    pubkey: string
    pipStatus: 'known' | 'partial' | 'unknown' | 'contested'
  }
  content: string
  publishedAt: string
  isDeleted: boolean
  isMuted: boolean
}

export interface ConversationResponse {
  rootEventId: string
  rootKind: number
  repliesEnabled: boolean
  paywallLocked: boolean
  nodes: ConversationNode[]
}

export const replies = {
  getForTarget: (targetEventId: string) =>
    request<ReplyResponse>(`/replies/${targetEventId}`),

  // Whole conversation keyed by any node's event id — the client re-roots on
  // any node without refetching.
  conversation: (eventId: string) =>
    request<ConversationResponse>(`/conversation/${eventId}`),

  deleteReply: (replyId: string) =>
    request<{ ok: boolean }>(`/replies/${replyId}`, { method: 'DELETE' }),

  toggleArticleReplies: (articleId: string, enabled: boolean) =>
    request<{ ok: boolean }>(`/articles/${articleId}/replies`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  toggleNoteReplies: (noteId: string, enabled: boolean) =>
    request<{ ok: boolean }>(`/notes/${noteId}/replies`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
}
