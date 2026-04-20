import { request } from './client'

export interface ResolverMatch {
  type: 'native_account' | 'external_source' | 'rss_feed'
  confidence: 'exact' | 'probable' | 'speculative'
  account?: {
    id: string
    username: string
    displayName: string
    avatar?: string
  }
  externalSource?: {
    protocol: string
    sourceUri: string
    displayName?: string
    avatar?: string
    description?: string
    relayUrls?: string[]
  }
  rssFeed?: {
    feedUrl: string
    title?: string
    description?: string
  }
}

export interface ResolverResult {
  inputType: string
  matches: ResolverMatch[]
  status?: 'pending' | 'complete'
  error?: string
  requestId?: string
  pendingResolutions?: string[]
}

export const resolver = {
  resolve: (query: string, context?: 'subscribe' | 'invite' | 'dm' | 'general') =>
    request<ResolverResult>('/resolve', {
      method: 'POST',
      body: JSON.stringify({ query, context }),
    }),

  poll: (requestId: string) =>
    request<ResolverResult>(`/resolve/${requestId}`),
}
