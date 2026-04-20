import { randomUUID } from 'node:crypto'
import { nip19 } from 'nostr-tools'
import { WebSocket } from 'ws'
import { pool } from '@platform-pub/shared/db/client.js'
import { pinnedWebSocketOptions, safeFetch } from '@platform-pub/shared/lib/http-client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { getProfile as atprotoGetProfile, resolveHandle as atprotoResolveHandle, extractFromBskyUrl, isDid as isAtprotoDid } from './atproto-resolve.js'
import { resolveWebFinger, fetchActorProfile, extractFromMastodonUrl } from './activitypub-resolve.js'

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
  | 'dotted_host' | 'platform_username' | 'free_text'

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
  // Phase A returns 'complete' immediately when there is no async work; otherwise
  // 'pending' until resolveAsync overwrites the row with 'complete'. Lets the
  // poll caller distinguish "still running" from "done, no matches" without
  // inferring from pendingResolutions array length.
  status?: 'pending' | 'complete'
  error?: string
  requestId?: string
  pendingResolutions?: string[]
}

// Phase B results are stored in `resolver_async_results` (migration 061) so
// the initial resolve and the subsequent poll can land on different gateway
// replicas. Each row is bound to the initiator so a leaked request_id can't
// be used by another account to read someone else's lookup output.
const ASYNC_TTL_MS = 60_000

export async function getAsyncResult(
  requestId: string,
  initiatorId: string
): Promise<ResolverResult | null> {
  // UUID type mismatches throw on older Postgres versions — guard explicitly.
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return null
  const { rows } = await pool.query<{ result: ResolverResult }>(
    `SELECT result FROM resolver_async_results
      WHERE request_id = $1 AND initiator_id = $2 AND expires_at > now()`,
    [requestId, initiatorId]
  )
  if (rows.length === 0) return null
  return rows[0].result
}

// Cap per-initiator rows so a spammy client can't bloat the table between
// the 5-min prune cycles. 100 is ~100× the normal concurrent-lookup working
// set; anything above that is either abuse or a leaking client.
const MAX_ROWS_PER_INITIATOR = 100

async function storeAsyncResult(
  requestId: string,
  initiatorId: string,
  result: ResolverResult
): Promise<void> {
  await pool.query(
    `INSERT INTO resolver_async_results (request_id, initiator_id, result, expires_at)
     VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4))
     ON CONFLICT (request_id) DO UPDATE SET
       result = EXCLUDED.result,
       expires_at = EXCLUDED.expires_at`,
    [requestId, initiatorId, JSON.stringify(result), ASYNC_TTL_MS / 1000]
  )

  // Trim older rows for this initiator beyond the cap. OFFSET N LIMIT 1
  // returns the Nth-newest row's created_at; rows older than that are
  // dropped. Uses the (initiator_id, created_at DESC) index from
  // migration 064. Best-effort — a failure here shouldn't surface to the
  // resolve caller.
  try {
    await pool.query(
      `DELETE FROM resolver_async_results
        WHERE initiator_id = $1
          AND created_at < (
            SELECT created_at
              FROM resolver_async_results
             WHERE initiator_id = $1
             ORDER BY created_at DESC
             OFFSET $2 LIMIT 1
          )`,
      [initiatorId, MAX_ROWS_PER_INITIATOR]
    )
  } catch (err) {
    logger.warn({ err, initiatorId }, 'Failed to enforce resolver_async_results per-initiator cap')
  }
}

// =============================================================================
// Input classification (§V.5.1)
// =============================================================================

const HEX_64 = /^[0-9a-f]{64}$/i
// AT Protocol handles in the official Bluesky namespace — `.bsky.social`,
// `.bsky.team`. Custom-domain handles (e.g. `paul.gilkes.me`) look identical
// to RSS host names, so we only fast-path the suffixes we know are Bluesky;
// everything else falls into `dotted_host` which tries URL/RSS discovery
// first and atproto only as a fallback. Leading @ is optional.
const BLUESKY_HANDLE = /^@?[\w-]+\.bsky\.(social|team)$/i
// Generic dotted hostname-shaped string with no scheme — could be an RSS
// host (most common), a custom-domain Bluesky handle, or just a domain. Phase
// B tries URL discovery first, then atproto.
const DOTTED_HOST = /^[\w-]+(\.[\w-]+)+$/
const FEDIVERSE_HANDLE = /^@[\w.+-]+@[\w.-]+\.[\w.]+$/  // @user@instance.tld
const AMBIGUOUS_AT = /^[\w.+-]+@[\w.-]+\.[\w.]+$/  // user@domain.tld (no @ prefix)
const PLATFORM_USERNAME = /^[\w]+$/  // alphanumeric, no @, no .

function classifyInput(query: string): InputType {
  const trimmed = query.trim()

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return 'url'
  if (trimmed.startsWith('npub1')) return 'npub'
  if (trimmed.startsWith('nprofile1')) return 'nprofile'
  if (HEX_64.test(trimmed)) return 'hex_pubkey'
  if (trimmed.startsWith('did:plc:') || trimmed.startsWith('did:web:')) return 'did'
  if (FEDIVERSE_HANDLE.test(trimmed)) return 'fediverse_handle'
  if (AMBIGUOUS_AT.test(trimmed)) return 'ambiguous_at'
  if (BLUESKY_HANDLE.test(trimmed)) return 'bluesky_handle'
  if (DOTTED_HOST.test(trimmed)) return 'dotted_host'
  if (PLATFORM_USERNAME.test(trimmed) && trimmed.length >= 2) return 'platform_username'

  return 'free_text'
}

// =============================================================================
// Phase A — instant local classification + local lookups (< 50ms)
// =============================================================================

export async function resolve(
  query: string,
  context: ResolveContext = 'general',
  initiatorId?: string
): Promise<ResolverResult> {
  const trimmed = query.trim()
  if (!trimmed) {
    return { inputType: 'free_text', matches: [], error: 'Empty query' }
  }

  const inputType = classifyInput(trimmed)
  const matches: ResolverMatch[] = []
  const pendingResolutions: string[] = []
  // Phase B external chains are pointless for surfaces that only consume
  // native_account matches (publication invite, DM start). Skipping them in
  // Phase A means we don't even open a polling request.
  const skipExternal = context === 'invite' || context === 'dm'

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
          if (!skipExternal) pendingResolutions.push('nostr_profile')
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
          if (!skipExternal) pendingResolutions.push('nostr_profile')
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
      if (!skipExternal) pendingResolutions.push('nostr_profile')
      break
    }

    case 'did': {
      if (!skipExternal) pendingResolutions.push('atproto_profile')
      break
    }

    case 'bluesky_handle': {
      if (!skipExternal) pendingResolutions.push('atproto_profile')
      break
    }

    case 'fediverse_handle': {
      if (!skipExternal) pendingResolutions.push('activitypub_profile')
      break
    }

    case 'url': {
      // URL resolution requires network I/O — do Phase A classification
      // and kick off Phase B async
      if (!skipExternal) pendingResolutions.push('url_resolution')
      break
    }

    case 'dotted_host': {
      // Could be an RSS host or a custom-domain Bluesky handle. Try URL
      // discovery first (most common); atproto probe runs in parallel as a
      // fallback so custom-domain handles still resolve.
      if (!skipExternal) {
        pendingResolutions.push('url_resolution')
        pendingResolutions.push('atproto_profile')
      }
      break
    }

    case 'ambiguous_at': {
      // Try email lookup locally (instant); NIP-05 + WebFinger are Phase B.
      // NIP-05 can find native accounts (via pubkey lookup) so it runs even
      // for invite/DM contexts; WebFinger only yields external.
      const account = await lookupByEmail(trimmed)
      if (account) matches.push(account)
      pendingResolutions.push('nip05_resolution')
      if (!skipExternal) pendingResolutions.push('webfinger_resolution')
      break
    }

    case 'free_text': {
      const searchResults = await searchPlatform(trimmed)
      matches.push(...searchResults)
      break
    }
  }

  // Phase B lookups require DB persistence (see getAsyncResult). Callers that
  // don't have an initiator can't start async work — skip the pending chain
  // and return only the Phase A matches.
  const requestId = pendingResolutions.length > 0 && initiatorId
    ? randomUUID()
    : undefined

  const result: ResolverResult = {
    inputType,
    matches,
    status: requestId ? 'pending' : 'complete',
    requestId,
    pendingResolutions: requestId ? pendingResolutions : undefined,
  }

  if (requestId && initiatorId) {
    // Seed the initial partial result so a poll arriving before Phase B
    // completes still gets a meaningful response.
    await storeAsyncResult(requestId, initiatorId, { ...result }).catch(err => {
      logger.warn({ err, requestId }, 'Failed to seed resolver_async_results row')
    })

    // Fire-and-forget async Phase B
    resolveAsync(requestId, initiatorId, trimmed, inputType, matches, context).catch(err => {
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
  initiatorId: string,
  query: string,
  inputType: InputType,
  existingMatches: ResolverMatch[],
  context: ResolveContext
): Promise<void> {
  const matches = [...existingMatches]
  // External Phase B chains (URL/RSS, atproto, activitypub) only ever produce
  // external_source / rss_feed matches. Surfaces that act on platform accounts
  // — invite a publication member, start a DM — can't use those, so skip the
  // network round-trip. Native lookups in Phase A still run (npub/email/
  // username probe accounts directly) so an npub typed into invite still
  // finds the platform account.
  const skipExternal = context === 'invite' || context === 'dm'

  if (inputType === 'url' && !skipExternal) {
    const urlMatches = await resolveUrl(query)
    matches.push(...urlMatches)
  }

  if (inputType === 'dotted_host' && !skipExternal) {
    // Try URL discovery (synthesise https:// scheme) and atproto probe in
    // parallel. RSS path is the common case but custom-domain Bluesky handles
    // (e.g. paul.gilkes.me) also live here.
    const [urlMatches, atprotoMatch] = await Promise.all([
      resolveUrl(`https://${query}`),
      resolveAtproto(query),
    ])
    matches.push(...urlMatches)
    if (atprotoMatch) matches.push(atprotoMatch)
  }

  if (inputType === 'ambiguous_at') {
    const nip05Matches = await resolveNip05(query)
    matches.push(...nip05Matches)
    if (!skipExternal) {
      // Also try WebFinger — many fediverse accounts take the bare `user@host`
      // form (no @ prefix) and the ambiguous chain is the only place to catch
      // them. Dedupe against any existing activitypub match by actor URI.
      const apMatch = await resolveActivityPubHandle(query)
      if (apMatch && !matches.some(m =>
        m.externalSource?.protocol === 'activitypub' &&
        m.externalSource?.sourceUri === apMatch.externalSource?.sourceUri
      )) {
        matches.push(apMatch)
      }
    }
  }

  if (inputType === 'fediverse_handle' && !skipExternal) {
    const apMatch = await resolveActivityPubHandle(query)
    if (apMatch) matches.push(apMatch)
  }

  if ((inputType === 'did' || inputType === 'bluesky_handle') && !skipExternal) {
    const atprotoMatch = await resolveAtproto(query)
    if (atprotoMatch) matches.push(atprotoMatch)
  }

  if (
    (inputType === 'npub' || inputType === 'nprofile' || inputType === 'hex_pubkey')
    && !skipExternal
  ) {
    // Enrich the nostr_external match (if any) with displayName/avatar from the
    // pubkey's kind 0 metadata. nprofile carries relay hints; npub/hex_pubkey
    // fall back to NOSTR_PROFILE_RELAYS.
    const target = matches.find(m => m.externalSource?.protocol === 'nostr_external')
    if (target?.externalSource) {
      const profile = await fetchNostrProfile(
        target.externalSource.sourceUri,
        target.externalSource.relayUrls
      )
      if (profile) {
        target.externalSource.displayName = profile.displayName ?? target.externalSource.displayName
        target.externalSource.description = profile.about ?? target.externalSource.description
        target.externalSource.avatar = profile.picture ?? target.externalSource.avatar
      }
    }
  }

  // Persist the fully-resolved result; overwrites the partial row seeded by resolve().
  await storeAsyncResult(requestId, initiatorId, {
    inputType,
    matches,
    status: 'complete',
    pendingResolutions: [],
  })
}

// =============================================================================
// URL resolution (§V.5.2)
// =============================================================================

async function resolveUrl(url: string): Promise<ResolverMatch[]> {
  const matches: ResolverMatch[] = []

  try {
    const parsed = new URL(url)

    // 1. Known social platform patterns
    const bskyIdent = extractFromBskyUrl(parsed)
    if (bskyIdent !== null) {
      const match = await resolveAtproto(bskyIdent)
      return match ? [match] : []
    }

    const mastoHint = extractFromMastodonUrl(parsed)
    if (mastoHint) {
      const match = mastoHint.acct
        ? await resolveActivityPubHandle(mastoHint.acct)
        : mastoHint.actorUri
          ? await resolveActivityPubByActor(mastoHint.actorUri)
          : null
      if (match) return [match]
      // Fall through to RSS discovery if AP resolution fails — the URL may
      // still be something we can subscribe to.
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

// Per-origin memo so two users pasting the same URL don't trigger 14 hits to
// a dead host within the same window. ~5 minute TTL — long enough to cover
// debounce + retry, short enough that newly-published feeds appear without an
// admin restart.
const WELL_KNOWN_TTL_MS = 5 * 60_000
const wellKnownCache = new Map<string, { expires: number; result: ResolverMatch | null }>()

async function tryWellKnownPaths(origin: string): Promise<ResolverMatch | null> {
  const cached = wellKnownCache.get(origin)
  if (cached && cached.expires > Date.now()) return cached.result

  // Probe all paths in parallel and pick the first hit by WELL_KNOWN_PATHS
  // order (so /feed wins over /rss when both exist). One concurrent burst
  // beats seven sequential round-trips on dead origins where every probe
  // pays the full timeout.
  const results = await Promise.all(
    WELL_KNOWN_PATHS.map(path => tryRssFetch(origin + path))
  )
  const hit = results.find(r => r !== null) ?? null

  wellKnownCache.set(origin, { expires: Date.now() + WELL_KNOWN_TTL_MS, result: hit })
  // Cap the cache so a stream of garbage URLs can't grow it unbounded. 1000
  // origins × small payload = trivial memory.
  if (wellKnownCache.size > 1000) {
    const firstKey = wellKnownCache.keys().next().value
    if (firstKey) wellKnownCache.delete(firstKey)
  }
  return hit
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
// Nostr profile (kind 0) lookup — opens a temporary relay WebSocket and pulls
// the most recent kind-0 metadata event for the pubkey. Used to enrich
// external_source matches with displayName/avatar so the SubscribeInput
// dropdown shows something better than a hex string.
// =============================================================================

const NOSTR_PROFILE_TIMEOUT_MS = 4_000
const DEFAULT_NOSTR_PROFILE_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
]

interface NostrProfile {
  displayName?: string
  about?: string
  picture?: string
}

function getDefaultProfileRelays(): string[] {
  const env = process.env.NOSTR_PROFILE_RELAYS
  if (!env) return DEFAULT_NOSTR_PROFILE_RELAYS
  return env.split(',').map(s => s.trim()).filter(Boolean)
}

async function fetchNostrProfile(
  pubkey: string,
  relayHints?: string[]
): Promise<NostrProfile | null> {
  if (!HEX_64.test(pubkey)) return null
  const relays = relayHints && relayHints.length > 0 ? relayHints : getDefaultProfileRelays()
  // Race relays — first successful kind-0 wins. Newest createdAt as tiebreaker.
  const results = await Promise.allSettled(
    relays.map(relayUrl => fetchKind0FromRelay(relayUrl, pubkey))
  )

  let best: { event: { content: string; created_at: number } } | null = null
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      if (!best || r.value.created_at > best.event.created_at) {
        best = { event: r.value }
      }
    }
  }
  if (!best) return null
  try {
    const parsed = JSON.parse(best.event.content) as Record<string, unknown>
    return {
      displayName: typeof parsed.display_name === 'string' && parsed.display_name
        ? parsed.display_name
        : typeof parsed.name === 'string' ? parsed.name : undefined,
      about: typeof parsed.about === 'string' ? parsed.about : undefined,
      picture: typeof parsed.picture === 'string' ? parsed.picture : undefined,
    }
  } catch {
    return null
  }
}

function fetchKind0FromRelay(
  relayUrl: string,
  pubkey: string
): Promise<{ content: string; created_at: number } | null> {
  return new Promise(async (resolve) => {
    let wsOpts
    try {
      wsOpts = await pinnedWebSocketOptions(relayUrl)
    } catch (err) {
      logger.debug({ relayUrl, err }, 'Nostr profile relay rejected by SSRF guard')
      resolve(null)
      return
    }

    const ws = new WebSocket(relayUrl, wsOpts)
    const subId = `resolver-profile-${randomUUID()}`
    let latest: { content: string; created_at: number } | null = null
    let settled = false
    const finish = (value: { content: string; created_at: number } | null) => {
      if (settled) return
      settled = true
      try { ws.send(JSON.stringify(['CLOSE', subId])) } catch {}
      try { ws.close() } catch {}
      resolve(value)
    }

    const timeout = setTimeout(() => finish(latest), NOSTR_PROFILE_TIMEOUT_MS)

    ws.on('open', () => {
      ws.send(JSON.stringify([
        'REQ', subId,
        { kinds: [0], authors: [pubkey], limit: 1 },
      ]))
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          const event = msg[2]
          if (
            event && typeof event.content === 'string' &&
            typeof event.created_at === 'number' && event.pubkey === pubkey
          ) {
            if (!latest || event.created_at > latest.created_at) {
              latest = { content: event.content, created_at: event.created_at }
            }
          }
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          clearTimeout(timeout)
          finish(latest)
        }
      } catch {
        // ignore parse errors
      }
    })

    ws.on('error', () => {
      clearTimeout(timeout)
      finish(null)
    })

    ws.on('close', () => {
      clearTimeout(timeout)
      finish(latest)
    })
  })
}

// =============================================================================
// AT Protocol (Bluesky) resolution — DIDs, handles, bsky.app URLs all land
// here. We always end up with a DID as the canonical source_uri, plus
// profile metadata from the AppView.
// =============================================================================

async function resolveAtproto(identifier: string): Promise<ResolverMatch | null> {
  const trimmed = identifier.trim().replace(/^@/, '')
  if (!trimmed) return null

  // Handles and DIDs both go through getProfile, which accepts either.
  const profile = await atprotoGetProfile(trimmed)
  if (profile) {
    return {
      type: 'external_source',
      confidence: 'exact',
      externalSource: {
        protocol: 'atproto',
        sourceUri: profile.did,
        displayName: profile.displayName ?? `@${profile.handle}`,
        description: profile.description,
        avatar: profile.avatar,
      },
    }
  }

  // getProfile failed. If we started with a handle, try resolveHandle as a
  // fallback — some accounts resolve but their profile endpoint 404s.
  if (!isAtprotoDid(trimmed)) {
    const did = await atprotoResolveHandle(trimmed)
    if (did) {
      return {
        type: 'external_source',
        confidence: 'probable',
        externalSource: {
          protocol: 'atproto',
          sourceUri: did,
          displayName: `@${trimmed}`,
        },
      }
    }
  }

  return null
}

// =============================================================================
// ActivityPub (fediverse/Mastodon) resolution
// =============================================================================

async function resolveActivityPubHandle(handle: string): Promise<ResolverMatch | null> {
  const actorUri = await resolveWebFinger(handle)
  if (!actorUri) return null
  return resolveActivityPubByActor(actorUri)
}

async function resolveActivityPubByActor(actorUri: string): Promise<ResolverMatch | null> {
  const profile = await fetchActorProfile(actorUri)
  if (!profile) return null
  return {
    type: 'external_source',
    confidence: 'exact',
    externalSource: {
      protocol: 'activitypub',
      sourceUri: profile.actorUri,
      displayName: profile.displayName ?? profile.handle ?? profile.actorUri,
      description: profile.description ?? undefined,
      avatar: profile.avatar ?? undefined,
    },
  }
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
  // Escape LIKE metacharacters so a `%` in user input isn't treated as wildcard.
  const escaped = query.replace(/[%_\\]/g, '\\$&')
  const pattern = `%${escaped}%`

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
    [pattern, escaped]
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
