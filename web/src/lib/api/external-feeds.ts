import { request } from './client'

export interface ExternalSubscription {
  id: string
  isMuted: boolean
  dailyCap: number | null
  subscribedAt: string
  source: {
    id: string
    protocol: string
    sourceUri: string
    displayName: string | null
    avatarUrl: string | null
    description: string | null
    isActive: boolean
    errorCount: number
    lastError: string | null
    lastFetchedAt: string | null
    itemCount: number
  }
}

export const feeds = {
  subscribe: (data: { protocol: string; sourceUri: string; displayName?: string; description?: string; avatarUrl?: string; relayUrls?: string[] }) =>
    request<{ subscriptionId: string; sourceId: string }>('/feeds/subscribe', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  list: () =>
    request<{ subscriptions: ExternalSubscription[] }>('/feeds'),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/feeds/${id}`, { method: 'DELETE' }),

  update: (id: string, data: { isMuted?: boolean; dailyCap?: number | null }) =>
    request<{ ok: boolean }>(`/feeds/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  refresh: (id: string) =>
    request<{ ok: boolean }>(`/feeds/${id}/refresh`, { method: 'POST' }),
}
