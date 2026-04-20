import { safeFetch } from '@platform-pub/shared/lib/http-client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// ActivityPub identity resolution
//
// Two entry points:
//   resolveWebFinger(acct)   — resolves acct:user@domain to an actor URI via
//                              https://domain/.well-known/webfinger
//   fetchActorProfile(uri)   — fetches an actor document and returns display
//                              metadata. The universal resolver uses this for
//                              both fediverse handles and Mastodon URLs.
// =============================================================================

const AP_ACCEPT = 'application/activity+json, application/ld+json;profile="https://www.w3.org/ns/activitystreams", application/json;q=0.9'

interface ActorProfile {
  actorUri: string
  displayName: string | null
  description: string | null
  avatar: string | null
  handle: string | null       // e.g. alice@mastodon.social
}

// -----------------------------------------------------------------------------
// WebFinger: acct:user@domain → actor URI
// -----------------------------------------------------------------------------

export async function resolveWebFinger(acct: string): Promise<string | null> {
  const clean = acct.replace(/^@+/, '')
  const [user, domain] = clean.split('@')
  if (!user || !domain) return null

  const url = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${clean}`)}`
  try {
    const res = await safeFetch(url, { headers: { 'Accept': 'application/jrd+json, application/json' } })
    if (!res.ok) return null
    const body = JSON.parse(res.text)
    const links = Array.isArray(body.links) ? body.links : []
    for (const link of links) {
      if (
        link?.rel === 'self' &&
        (link?.type === 'application/activity+json' ||
         link?.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"') &&
        typeof link.href === 'string'
      ) {
        return link.href
      }
    }
    return null
  } catch (err) {
    logger.debug({ acct, err }, 'WebFinger resolution failed')
    return null
  }
}

// -----------------------------------------------------------------------------
// Actor fetch → profile metadata
// -----------------------------------------------------------------------------

export async function fetchActorProfile(actorUri: string): Promise<ActorProfile | null> {
  try {
    const res = await safeFetch(actorUri, { headers: { 'Accept': AP_ACCEPT } })
    if (!res.ok) return null
    const actor = JSON.parse(res.text)
    if (!actor || typeof actor !== 'object') return null

    const id = typeof actor.id === 'string' ? actor.id : actorUri
    let host: string
    try { host = new URL(id).hostname } catch { return null }

    const username = typeof actor.preferredUsername === 'string' ? actor.preferredUsername : null
    const handle = username ? `${username}@${host}` : null
    const avatar = extractImageUrl(actor.icon)
    const description = typeof actor.summary === 'string' ? stripTags(actor.summary) : null

    return {
      actorUri: id,
      displayName: typeof actor.name === 'string' && actor.name ? actor.name : handle,
      description,
      avatar,
      handle,
    }
  } catch (err) {
    logger.debug({ actorUri, err }, 'Actor fetch failed')
    return null
  }
}

function extractImageUrl(obj: any): string | null {
  if (!obj) return null
  if (typeof obj === 'string') return obj
  if (typeof obj.url === 'string') return obj.url
  if (Array.isArray(obj) && obj.length > 0) return extractImageUrl(obj[0])
  return null
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

// -----------------------------------------------------------------------------
// URL patterns — a Mastodon profile URL can take several shapes:
//   https://mastodon.social/@alice
//   https://mastodon.social/users/alice
//   https://mastodon.social/@alice@other.instance  (remote profile view)
//
// Returns an `acct:` handle ready for WebFinger, or an actor URI if the URL
// is already actor-shaped.
// -----------------------------------------------------------------------------

export function extractFromMastodonUrl(url: URL): { acct?: string; actorUri?: string } | null {
  const path = url.pathname

  // /@alice or /@alice@remote.host
  const atMatch = path.match(/^\/@([^/@]+)(?:@([^/]+))?\/?$/)
  if (atMatch) {
    const user = atMatch[1]
    const remoteHost = atMatch[2] ?? url.hostname
    return { acct: `${user}@${remoteHost}` }
  }

  // /users/alice → looks actor-shaped, return as-is
  const usersMatch = path.match(/^\/users\/([^/]+)\/?$/)
  if (usersMatch) {
    return { actorUri: `${url.origin}/users/${usersMatch[1]}` }
  }

  return null
}
