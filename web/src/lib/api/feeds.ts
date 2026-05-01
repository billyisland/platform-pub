import { request } from './client'

// Workspace feeds — owner-private feed objects, one per ⊔ vessel. Slice 3
// surface; source-set wiring arrives later.

export interface WorkspaceFeed {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  sourceCount: number
}

export interface WorkspaceFeedItemsResponse {
  feed: WorkspaceFeed
  items: any[]
  nextCursor?: string
  placeholder: boolean
}

export const workspaceFeeds = {
  list: () => request<{ feeds: WorkspaceFeed[] }>('/feeds'),

  create: (name: string) =>
    request<{ feed: WorkspaceFeed }>('/feeds', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  rename: (id: string, name: string) =>
    request<{ feed: WorkspaceFeed }>(`/feeds/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  remove: (id: string) =>
    request<void>(`/feeds/${id}`, { method: 'DELETE' }),

  items: (id: string, opts?: { cursor?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (opts?.cursor) qs.set('cursor', opts.cursor)
    if (opts?.limit) qs.set('limit', String(opts.limit))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<WorkspaceFeedItemsResponse>(`/feeds/${id}/items${suffix}`)
  },
}
