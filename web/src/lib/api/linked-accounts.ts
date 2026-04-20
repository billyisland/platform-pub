import { request } from './client'

export interface LinkedAccount {
  id: string
  protocol: 'atproto' | 'activitypub' | 'nostr_external' | 'rss'
  externalId: string
  externalHandle: string | null
  instanceUrl: string | null
  isValid: boolean
  crossPostDefault: boolean
  tokenExpiresAt: string | null
  createdAt: string
}

export const linkedAccounts = {
  list: () => request<{ accounts: LinkedAccount[] }>('/linked-accounts'),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/linked-accounts/${id}`, { method: 'DELETE' }),

  update: (id: string, data: { crossPostDefault: boolean }) =>
    request<{ ok: boolean }>(`/linked-accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  connectMastodon: (instanceUrl: string) =>
    request<{ authorizeUrl: string }>('/linked-accounts/mastodon', {
      method: 'POST',
      body: JSON.stringify({ instanceUrl }),
    }),

  connectBluesky: (handle: string) =>
    request<{ authorizeUrl: string }>('/linked-accounts/bluesky', {
      method: 'POST',
      body: JSON.stringify({ handle }),
    }),
}
