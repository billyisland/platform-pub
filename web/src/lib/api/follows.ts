import { request } from './client'

export const follows = {
  listPubkeys: () =>
    request<{ pubkeys: string[] }>('/follows/pubkeys'),

  follow: (writerId: string) =>
    request<{ ok: boolean }>(`/follows/${writerId}`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  unfollow: (writerId: string) =>
    request<{ ok: boolean }>(`/follows/${writerId}`, { method: 'DELETE' }),
}
