import { randomUUID } from 'node:crypto'
import { nip19 } from 'nostr-tools'
import { pool } from '../../shared/src/db/client.js'
import { safeFetch } from '../../shared/src/lib/http-client.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Universal Resolver
//
// Takes an arbitrary string — whatever the user has — and resolves it to one
// or more candidate identities: a native all.haus account, an external source
// (for subscription), or both.
//
// Per ADR §V.5: input classification is deterministic, not probabilistic.
// Phase 1 supports: URLs (RSS discovery), platform usernames, npub/nprofile,
// hex pubkeys, NIP-05, and free-text search. Bluesky/fediverse chains are
// stubs returning "coming soon".
// =============================================================================

export type InputType =
  | 'url' | 'npub' | 'nprofile' | 'hex_pubkey' | 'did'
  | 'bluesky_handle' | 'fediverse_handle' | 'ambiguous_at'
  | 'platform_username' | 'free_text'

export type MatchType = 'native_account' | 'external_source' | 'rss_feed'
export type Confidence = 'exact' | 'probable' | 'speculative'
export type ResolveContext = 'subscribe' | 'invite' | 'dm' | 'general'

export interface ResolverMatch {
  type: MatchType
  confidence: Confidence
  account?: {
    id: string
    username: string
    displayName: string
    avatar?: string
  }
  externalSource?: {
    protocol: 'atproto' | 'activitypub' | 'rss' | 'nostr_external'
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
  inputType: InputType
  matches: ResolverMatch[]
  error?: string
  requestId?: string
  pendingResolutions?: string[]
}

// In-memory cache for async resolution results (Phase B)
const asyncResults = new Map<string, { result: ResolverResult; expiresAt: number }>()
const ASYNC_TTL_MS = 60_000

// Cleanup stale entries every 30 seconds
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of asyncResults) {
    if (entry.expiresAt < now) asyncResults.delete(key)
  }
}, 30_000)

export function getAsyncResult(requestId: string): ResolverResult | null {
  const entry = asyncResults.get(requestId)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    asyncResults.delete(requestId)
    return null
  }
  return entry.result
}

// =============================================================================
// Input classification (§V.5.1)
// =============================================================================

const HEX_64 = /^[0-9a-f]{64}$/i
const BLUESKY_HANDLE = /^@[\w.-]+\.[\w.-]+$/  // @handle.bsky.social or @handle.tld
const FEDIVERSE_HANDLE = /^@[\w.-]+@[\w.-]+\.[\w]+$/  // @user@instance.tld
const AMBIGUOUS_AT = /^[\w.-]+@[\w.-]+\.[\w]+$/  // user@domain.tld (no @ prefix)
const PLATFORM_USERNAME = /^[\w]+$/  // alphanumeric, no @, no .

function classifyInput(query: string): InputType {
  const trimmed = query.trim()

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return 'url'
  if (trimmed.startsWith('npub1')) return 'npub'
  if (trimmed.startsWith('nprofile1')) return 'nprofile'
  if (HEX_64.test(trimmed)) return 'hex_pubkey'
  if (trimmed.startsWith('did:plc:') || trimmed.startsWith('did:web:')) return 'did'
  if (FEDIVERSE_HANDLE.test(trimmed)) return 'fediverse_handle'
  if (BLUESKY_HANDLE.test(trimmed)) return 'bluesky_handle'
  if (AMBIGUOUS_AT.test(trimmed)) return 'ambiguous_at'
  if (PLATFORM_USERNAME.test(trimmed) && trimmed.length >= 2) return 'platform_username'

  return 'free_text'
}

// =============================================================================
// Phase A — instant local classification + local lookups (< 50ms)
// =============================================================================

export async function resolve(
  query: string,
  context: ResolveContext = 'general'
): Promise<ResolverResult> {
  const trimmed = query.trim()
  if (!trimmed) {
    return { inputType: 'free_text', matches: [], error: 'Empty query' }
  }

  const inputType = classifyInput(trimmed)
  const matches: ResolverMatch[] = []
  const pendingResolutions: string[] = []

  switch (inputType) {
    case 'platform_username': {
      const account = await lookupByUsername(trimmed)
      if (account) matches.push(account)
      break
    }

    case 'npub': {
      try {
        const decoded = nip19.decode(trimmed)
        if (decoded.type === 'npub') {
          const hexPubkey = decoded.data as string
          const account = await lookupByPubkey(hexPubkey)
          if (account) matches.push(account)
          // Also offer as external Nostr source
          matches.push({
            type: 'external_source',
            confidence: 'exact',
            externalSource: {
              protocol: 'nostr_external',
              sourceUri: hexPubkey,
            },
          })
        }
      } catch {
        return { inputType, matches: [], error: 'Invalid npub encoding' }
      }
      break
    }

    case 'nprofile': {
      try {
        const decoded = nip19.decode(trimmed)
        if (decoded.type === 'nprofile') {
          const data = decoded.data as { pubkey: string; relays?: string[] }
          const account = await lookupByPubkey(data.pubkey)
          if (account) matches.push(account)
          matches.push({
            type: 'external_source',
            confidence: 'exact',
            externalSource: {
              protocol: 'nostr_external',
              sourceUri: data.pubkey,
              relayUrls: data.relays,
            },
          })
        }
      } catch {
        return { inputType, matches: [], error: 'Invalid nprofile encoding' }
      }
      break
    }

    case 'hex_pubkey': {
      const account = await lookupByPubkey(trimmed)
      if (account) matches.push(account)
      matches.push({
        type: 'external_source',
        confidence: 'exact',
        externalSource: {
          protocol: 'nostr_external',
          sourceUri: trimmed,
        },
      })
      break
    }

    case 'did': {
      // Phase 1 stub — Bluesky DID resolution not yet implemented
      return {
        inputType,
        matches: [],
        error: 'Bluesky (AT Protocol) support is coming soon. Try pasting an RSS feed URL for now.',
      }
    }

    case 'bluesky_handle': {
      return {
        inputType,
        matches: [],
        error: 'Bluesky handle resolution is coming soon. Try pasting an RSS feed URL for now.',
      }
    }

    case 'fediverse_handle': {
      return {
        inputType,
        matches: [],
        error: 'Fediverse handle resolution is coming soon. Try pasting an RSS feed URL for now.',
      }
    }

    case 'url': {
      // URL resolution requires network I/O — do Phase A classification
      // and kick off Phase B async
      pendingResolutions.push('url_resolution')
      break
    }

    case 'ambiguous_at': {
      // Try email lookup locally (instant), NIP-05 and WebFinger are Phase B
      const account = await lookupByEmail(trimmed)
      if (account) matches.push(account)
      pendingResolutions.push('nip05_resolution')
      // WebFinger is a stub in Phase 1
      break
    }

    case 'free_text': {
      const searchResults = await searchPlatform(trimmed)
      matches.push(...searchResults)
      break
    }
  }

  // If there are pending async resolutions, start them in background
  const requestId = pendingResolutions.length > 0 ? randomUUID() : undefined

  const result: ResolverResult = {
    inputType,
    matches,
    requestId,
    pendingResolutions: pendingResolutions.length > 0 ? pendingResolutions : undefined,
  }

  if (requestId) {
    // Store initial result and kick off async resolutions
    asyncResults.set(requestId, {
      result: { ...result },
      expiresAt: Date.now() + ASYNC_TTL_MS,
    })

    // Fire-and-forget async Phase B
    resolveAsync(requestId, trimmed, inputType, matches, context).catch(err => {
      logger.warn({ err, requestId }, 'Async resolution failed')
    })
  }

  return result
}

// =============================================================================
// Phase B — async remote resolutions
// =============================================================================

async function resolveAsync(
  requestId: string,
  query: string,
  inputType: InputType,
  existingMatches: ResolverMatch[],
  context: ResolveContext
): Promise<void> {
  const matches = [...existingMatches]

  if (inputType === 'url') {
    const urlMatches = await resolveUrl(query)
    matches.push(...urlMatches)
  }

  if (inputType === 'ambiguous_at') {
    const nip05Matches = await resolveNip05(query)
    matches.push(...nip05Matches)
  }

  // Update async cache with complete results
  const entry = asyncResults.get(requestId)
  if (entry) {
    entry.result = {
      inputType,
      matches,
      pendingResolutions: [],  // all done
    }
  }
}

// =============================================================================
// URL resolution (§V.5.2)
// =============================================================================

async function resolveUrl(url: string): Promise<ResolverMatch[]> {
  const matches: ResolverMatch[] = []

  try {
    const parsed = new URL(url)

    // 1. Known social platform patterns
    if (parsed.hostname === 'bsky.app' || parsed.hostname === 'staging.bsky.app') {
      return [{
        type: 'external_source',
        confidence: 'exact',
        externalSource: {
          protocol: 'atproto',
          sourceUri: url,
          displayName: 'Bluesky profile',
        },
      }]
      // Note: actual DID resolution is Phase 3
    }

    if (parsed.hostname === 'twitter.com' || parsed.hostname === 'x.com') {
      return []  // Not supported; frontend can show a message
    }

    // 2. Try fetching as RSS/Atom directly
    const rssFeed = await tryRssFetch(url)
    if (rssFeed) {
      matches.push(rssFeed)
      return matches
    }

    // 3. Try HTML link discovery
    const discovered = await discoverRssFromHtml(url)
    if (discovered) {
      matches.push(discovered)
      return matches
    }

    // 4. Try well-known paths
    const wellKnown = await tryWellKnownPaths(parsed.origin)
    if (wellKnown) {
      matches.push(wellKnown)
      return matches
    }

  } catch (err) {
    logger.debug({ url, err }, 'URL resolution failed')
  }

  return matches
}

async function tryRssFetch(url: string): Promise<ResolverMatch | null> {
  try {
    const response = await safeFetch(url, {
      headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html' },
    })
    if (!response.ok) return null

    const contentType = response.headers.get('content-type') ?? ''
    const isXml = contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom')

    if (isXml || response.text.trimStart().startsWith('<?xml') || response.text.trimStart().startsWith('<rss') || response.text.trimStart().startsWith('<feed')) {
      // Parse to extract metadata
      const Parser = (await import('rss-parser')).default
      const parser = new Parser({ timeout: 5000 })
      try {
        const feed = await parser.parseString(response.text)
        return {
          type: 'rss_feed',
          confidence: 'exact',
          rssFeed: {
            feedUrl: url,
            title: feed.title ?? undefined,
            description: feed.description ?? undefined,
          },
        }
      } catch {
        // Looked like XML but failed to parse as feed
        return null
      }
    }

    return null
  } catch {
    return null
  }
}

async function discoverRssFromHtml(url: string): Promise<ResolverMatch | null> {
  try {
    const response = await safeFetch(url, {
      headers: { 'Accept': 'text/html' },
    })
    if (!response.ok) return null

    // Look for <link rel="alternate" type="application/rss+xml"> or atom+xml
    const rssLink = extractFeedLink(response.text)
    if (!rssLink) return null

    // Resolve relative URL
    const feedUrl = new URL(rssLink, url).toString()

    // Verify it's actually a feed
    return tryRssFetch(feedUrl)
  } catch {
    return null
  }
}

function extractFeedLink(html: string): string | null {
  // Match <link> tags with rel="alternate" and RSS/Atom type
  const linkRegex = /<link[^>]*\srel=["']alternate["'][^>]*>/gi
  const matches = html.match(linkRegex)
  if (!matches) return null

  for (const tag of matches) {
    const typeMatch = tag.match(/type=["'](application\/(?:rss|atom)\+xml)["']/)
    if (!typeMatch) continue

    const hrefMatch = tag.match(/href=["']([^"']+)["']/)
    if (hrefMatch) return hrefMatch[1]
  }

  return null
}

const WELL_KNOWN_PATHS = ['/feed', '/rss', '/atom.xml', '/feed.xml', '/index.xml', '/feed/rss', '/blog/feed']

async function tryWellKnownPaths(origin: string): Promise<ResolverMatch | null> {
  for (const path of WELL_KNOWN_PATHS) {
    const candidate = origin + path
    const result = await tryRssFetch(candidate)
    if (result) return result
  }
  return null
}

// =============================================================================
// NIP-05 resolution
// =============================================================================

async function resolveNip05(identifier: string): Promise<ResolverMatch[]> {
  const matches: ResolverMatch[] = []
  const [name, domain] = identifier.split('@')
  if (!name || !domain) return matches

  try {
    const response = await safeFetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      { timeout: 5000 }
    )
    if (!response.ok) return matches

    const data = JSON.parse(response.text)
    const pubkey = data?.names?.[name]
    if (typeof pubkey === 'string' && HEX_64.test(pubkey)) {
      // Check if this is a platform account
      const account = await lookupByPubkey(pubkey)
      if (account) matches.push(account)

      // Also offer as external Nostr source
      const relays = data?.relays?.[pubkey]
      matches.push({
        type: 'external_source',
        confidence: 'exact',
        externalSource: {
          protocol: 'nostr_external',
          sourceUri: pubkey,
          displayName: `${name}@${domain}`,
          relayUrls: Array.isArray(relays) ? relays : undefined,
        },
      })
    }
  } catch (err) {
    logger.debug({ identifier, err }, 'NIP-05 resolution failed')
  }

  return matches
}

// =============================================================================
// Local lookups
// =============================================================================

async function lookupByUsername(username: string): Promise<ResolverMatch | null> {
  const { rows } = await pool.query<{
    id: string; username: string; display_name: string | null; avatar_blossom_url: string | null
  }>(
    `SELECT id, username, display_name, avatar_blossom_url FROM accounts
     WHERE username = $1 AND status = 'active'`,
    [username]
  )
  if (rows.length === 0) return null
  const row = rows[0]
  return {
    type: 'native_account',
    confidence: 'exact',
    account: {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? row.username,
      avatar: row.avatar_blossom_url ?? undefined,
    },
  }
}

async function lookupByPubkey(hexPubkey: string): Promise<ResolverMatch | null> {
  const { rows } = await pool.query<{
    id: string; username: string; display_name: string | null; avatar_blossom_url: string | null
  }>(
    `SELECT id, username, display_name, avatar_blossom_url FROM accounts
     WHERE nostr_pubkey = $1 AND status = 'active'`,
    [hexPubkey]
  )
  if (rows.length === 0) return null
  const row = rows[0]
  return {
    type: 'native_account',
    confidence: 'exact',
    account: {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? row.username,
      avatar: row.avatar_blossom_url ?? undefined,
    },
  }
}

async function lookupByEmail(email: string): Promise<ResolverMatch | null> {
  const { rows } = await pool.query<{
    id: string; username: string; display_name: string | null; avatar_blossom_url: string | null
  }>(
    `SELECT id, username, display_name, avatar_blossom_url FROM accounts
     WHERE email = $1 AND status = 'active'`,
    [email]
  )
  if (rows.length === 0) return null
  const row = rows[0]
  return {
    type: 'native_account',
    confidence: 'exact',
    account: {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? row.username,
      avatar: row.avatar_blossom_url ?? undefined,
    },
  }
}

async function searchPlatform(query: string): Promise<ResolverMatch[]> {
  const matches: ResolverMatch[] = []
  const pattern = `%${query}%`

  // Search writers
  const { rows: writers } = await pool.query<{
    id: string; username: string; display_name: string | null; avatar_blossom_url: string | null
  }>(
    `SELECT id, username, display_name, avatar_blossom_url FROM accounts
     WHERE status = 'active'
       AND (username ILIKE $1 OR display_name ILIKE $1)
     ORDER BY
       CASE WHEN username ILIKE $2 THEN 0 ELSE 1 END,
       display_name
     LIMIT 5`,
    [pattern, query]
  )

  for (const row of writers) {
    matches.push({
      type: 'native_account',
      confidence: 'speculative',
      account: {
        id: row.id,
        username: row.username,
        displayName: row.display_name ?? row.username,
        avatar: row.avatar_blossom_url ?? undefined,
      },
    })
  }

  return matches
}
