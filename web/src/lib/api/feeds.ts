import { request } from './client'

// Workspace feeds — owner-private feed objects, one per ⊔ vessel. Slice 4
// adds source CRUD; the items endpoint now honours source rows.

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

export type WorkspaceFeedSourceKind =
  | 'account'
  | 'publication'
  | 'external_source'
  | 'tag'

export interface WorkspaceFeedSource {
  id: string
  sourceType: WorkspaceFeedSourceKind
  weight: number
  samplingMode: string
  mutedAt: string | null
  createdAt: string
  display: {
    kind: WorkspaceFeedSourceKind
    label: string
    sublabel: string | null
    avatar: string | null
  }
}

export type AddWorkspaceFeedSourceInput =
  | { sourceType: 'account'; accountId: string }
  | { sourceType: 'publication'; publicationId: string }
  | { sourceType: 'tag'; tagName: string }
  | { sourceType: 'external_source'; externalSourceId: string }
  | {
      sourceType: 'external_source'
      protocol: 'rss' | 'atproto' | 'activitypub' | 'nostr_external'
      sourceUri: string
      displayName?: string
      description?: string
      avatarUrl?: string
      relayUrls?: string[]
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

  // Slice 4: source authoring
  listSources: (id: string) =>
    request<{ sources: WorkspaceFeedSource[] }>(`/feeds/${id}/sources`),

  addSource: (id: string, input: AddWorkspaceFeedSourceInput) =>
    request<{ source: WorkspaceFeedSource }>(`/feeds/${id}/sources`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  removeSource: (id: string, sourceId: string) =>
    request<void>(`/feeds/${id}/sources/${sourceId}`, { method: 'DELETE' }),
}
