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

export interface NetworkCapabilities {
  assistedBluesky: boolean
}

// Honest framing for the ASSISTED hand-off (NETWORK-CONCIERGE-ADR §6.1.1 S5,
// §10): the user is creating a *real* Bluesky account mid-redirect, so this must
// be an explicit acknowledgement, never ambient copy.
export const ASSISTED_BLUESKY_CONSENT =
  'You’re about to create a real Bluesky account on bsky.social. Bluesky holds the keys; all.haus just connects it. You can disconnect anytime.'

export const linkedAccounts = {
  list: () =>
    request<{ accounts: LinkedAccount[]; capabilities?: NetworkCapabilities }>(
      '/linked-accounts',
    ),

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

  // ASSISTED — "set one up for me." No handle: the gateway seeds the OAuth flow
  // with the PDS hostname so Bluesky renders native signup mid-redirect.
  assistedBluesky: () =>
    request<{ authorizeUrl: string }>('/linked-accounts/bluesky/assisted', {
      method: 'POST',
    }),
}

// Session-cached so contextual surfaces (e.g. InlineReplyBox) can gate the
// ASSISTED affordance on the server flag without a fetch each render.
let capabilitiesPromise: Promise<NetworkCapabilities> | null = null
export function getNetworkCapabilities(): Promise<NetworkCapabilities> {
  if (!capabilitiesPromise) {
    capabilitiesPromise = linkedAccounts
      .list()
      .then((r) => r.capabilities ?? { assistedBluesky: false })
      .catch(() => {
        capabilitiesPromise = null
        return { assistedBluesky: false }
      })
  }
  return capabilitiesPromise
}
