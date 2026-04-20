import { safeFetch } from '@platform-pub/shared/lib/http-client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// AT Protocol (Bluesky) identity resolution helpers.
//
// Phase 3: read-only resolution. We talk to the public AppView — no auth
// required for identity resolution or profile reads:
//
//   com.atproto.identity.resolveHandle — handle → DID
//   app.bsky.actor.getProfile          — DID/handle → display metadata
//
// All fetches go through safeFetch (SSRF-hardened; 10s timeout, 5MB cap,
// 3-redirect max).
//
// Note: we use the AppView for everything rather than resolving handles
// via DNS TXT / .well-known/atproto-did and then hitting the user's PDS
// directly. The AppView does the same work and is the canonical public
// read interface. If/when we add outbound posting (Phase 5) we'll need
// the real PDS URL — we'll do that via the DID doc at that point.
// =============================================================================

const APPVIEW = 'https://public.api.bsky.app'

interface AtprotoProfile {
  did: string
  handle: string
  displayName?: string
  description?: string
  avatar?: string
}

const DID_RE = /^did:(?:plc|web):[A-Za-z0-9._:-]+$/

export function isDid(s: string): boolean {
  return DID_RE.test(s)
}

// Strip an optional leading @ and normalise to lowercase. AT Protocol handles
// are case-insensitive per the spec.
export function normaliseHandle(h: string): string {
  return h.replace(/^@/, '').toLowerCase()
}

// Extract a handle or DID from a Bluesky profile URL.
// Matches: https://bsky.app/profile/handle.bsky.social
//          https://bsky.app/profile/did:plc:...
export function extractFromBskyUrl(url: URL): string | null {
  if (url.hostname !== 'bsky.app' && url.hostname !== 'staging.bsky.app') return null
  const m = url.pathname.match(/^\/profile\/([^\/]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

// =============================================================================
// resolveHandle: handle → DID
// =============================================================================

export async function resolveHandle(handle: string): Promise<string | null> {
  const normalised = normaliseHandle(handle)
  try {
    const res = await safeFetch(
      `${APPVIEW}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalised)}`,
      { headers: { 'Accept': 'application/json' } }
    )
    if (!res.ok) return null
    const data = JSON.parse(res.text) as { did?: unknown }
    return typeof data.did === 'string' && isDid(data.did) ? data.did : null
  } catch (err) {
    logger.debug({ handle, err }, 'resolveHandle failed')
    return null
  }
}

// =============================================================================
// getProfile: DID or handle → display metadata
// =============================================================================

export async function getProfile(actor: string): Promise<AtprotoProfile | null> {
  const normalised = actor.startsWith('did:') ? actor : normaliseHandle(actor)
  try {
    const res = await safeFetch(
      `${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(normalised)}`,
      { headers: { 'Accept': 'application/json' } }
    )
    if (!res.ok) return null
    const data = JSON.parse(res.text) as {
      did?: unknown
      handle?: unknown
      displayName?: unknown
      description?: unknown
      avatar?: unknown
    }
    if (typeof data.did !== 'string' || !isDid(data.did)) return null
    if (typeof data.handle !== 'string') return null
    return {
      did: data.did,
      handle: data.handle,
      displayName: typeof data.displayName === 'string' ? data.displayName : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      avatar: typeof data.avatar === 'string' ? data.avatar : undefined,
    }
  } catch (err) {
    logger.debug({ actor, err }, 'getProfile failed')
    return null
  }
}
