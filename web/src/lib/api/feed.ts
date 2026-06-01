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

export const replies = {
  getForTarget: (targetEventId: string) =>
    request<ReplyResponse>(`/replies/${targetEventId}`),

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
