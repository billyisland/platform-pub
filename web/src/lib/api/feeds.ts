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
  list: () => request<{ feeds: WorkspaceFeed[] }>('/workspace/feeds'),

  create: (name: string) =>
    request<{ feed: WorkspaceFeed }>('/workspace/feeds', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  rename: (id: string, name: string) =>
    request<{ feed: WorkspaceFeed }>(`/workspace/feeds/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  remove: (id: string) =>
    request<void>(`/workspace/feeds/${id}`, { method: 'DELETE' }),

  items: (id: string, opts?: { cursor?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (opts?.cursor) qs.set('cursor', opts.cursor)
    if (opts?.limit) qs.set('limit', String(opts.limit))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<WorkspaceFeedItemsResponse>(`/workspace/feeds/${id}/items${suffix}`)
  },

  // Slice 4: source authoring
  listSources: (id: string) =>
    request<{ sources: WorkspaceFeedSource[] }>(`/workspace/feeds/${id}/sources`),

  addSource: (id: string, input: AddWorkspaceFeedSourceInput) =>
    request<{ source: WorkspaceFeedSource }>(`/workspace/feeds/${id}/sources`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  removeSource: (id: string, sourceId: string) =>
    request<void>(`/workspace/feeds/${id}/sources/${sourceId}`, { method: 'DELETE' }),

  // Slice 14: per-feed-per-author volume + sampling commitment surfaced from
  // the pip panel. step=null means "passive" (no row), step=0 mutes, 1..5 are
  // the committed levels mapped to feed_sources.weight server-side.
  getAuthorVolume: (feedId: string, pubkey: string) =>
    request<AuthorVolume>(`/workspace/feeds/${feedId}/author-volume/${pubkey}`),

  setAuthorVolume: (
    feedId: string,
    pubkey: string,
    body: { step: number; sampling: 'random' | 'top' },
  ) =>
    request<AuthorVolume>(`/workspace/feeds/${feedId}/author-volume/${pubkey}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  clearAuthorVolume: (feedId: string, pubkey: string) =>
    request<void>(`/workspace/feeds/${feedId}/author-volume/${pubkey}`, {
      method: 'DELETE',
    }),

  // Slice 20: per-feed saved-items list. Save key is feed_items.id (the
  // unified identifier); the BookmarkButton retires with the deprecated
  // chassis on merge, so the workspace's save story is solely this surface.
  listSaves: (id: string, opts?: { cursor?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (opts?.cursor) qs.set('cursor', opts.cursor)
    if (opts?.limit) qs.set('limit', String(opts.limit))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<WorkspaceFeedSavesResponse>(`/workspace/feeds/${id}/saves${suffix}`)
  },

  listSavedIds: (id: string) =>
    request<{ feedItemIds: string[] }>(`/workspace/feeds/${id}/saves/ids`),

  saveItem: (id: string, feedItemId: string) =>
    request<{ ok: true }>(`/workspace/feeds/${id}/saves`, {
      method: 'POST',
      body: JSON.stringify({ feedItemId }),
    }),

  unsaveItem: (id: string, feedItemId: string) =>
    request<void>(`/workspace/feeds/${id}/saves/${feedItemId}`, {
      method: 'DELETE',
    }),
}

export interface WorkspaceFeedSavesResponse {
  feed: WorkspaceFeed
  items: any[]
  nextCursor?: string
}

export interface AuthorVolume {
  authorPubkey: string
  accountId: string | null
  step: number | null
  sampling: 'random' | 'top'
  muted: boolean
}
