import { safeFetch } from '../../shared/src/lib/http-client.js'
import { sanitizeContent, stripHtml } from '../lib/sanitize.js'

// =============================================================================
// ActivityPub (Mastodon) outbox adapter
//
// Fetches an actor's public outbox and normalises each Note object into the
// shape expected by external_items + feed_items. See UNIVERSAL-FEED-ADR.md
// §VI.4.
//
// This is deliberately a minimal reader: we only ingest public `Create`
// activities whose object is a `Note`. Announces (boosts) and private posts
// are skipped. Deletes are not surfaced via outbox polling; ADR §VI.4 notes
// that inbox delivery (future phase) is the clean mechanism for tombstones.
// =============================================================================

const AP_ACCEPT = 'application/activity+json, application/ld+json;profile="https://www.w3.org/ns/activitystreams", application/json;q=0.9'
const PUBLIC_URI = 'https://www.w3.org/ns/activitystreams#Public'

export interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'link'
  url: string
  thumbnail?: string
  alt?: string
  width?: number
  height?: number
  mime_type?: string
  title?: string
  description?: string
}

export interface ActorMetadata {
  id: string
  name: string | null
  preferredUsername: string | null
  summary: string | null
  icon: string | null
  outbox: string
  url: string | null
  // Instance host derived from actor id
  host: string
}

export interface NormalisedActivityPubItem {
  sourceItemUri: string
  authorName: string | null
  authorHandle: string | null
  authorAvatarUrl: string | null
  authorUri: string
  contentText: string
  contentHtml: string
  language: string | null
  media: MediaAttachment[]
  sourceReplyUri: string | null
  sourceQuoteUri: string | null  // ActivityPub has no quote primitive; always null
  publishedAt: Date
  webUrl: string | null
  interactionData: {
    id: string
    activityId?: string
    replyTo?: string
    webUrl?: string
  }
}

// =============================================================================
// Actor fetch
// =============================================================================

export async function fetchActor(actorUri: string): Promise<ActorMetadata> {
  const res = await safeFetch(actorUri, { headers: { 'Accept': AP_ACCEPT } })
  if (!res.ok) throw new Error(`Actor fetch returned HTTP ${res.status}`)

  let actor: any
  try {
    actor = JSON.parse(res.text)
  } catch {
    throw new Error('Actor response is not valid JSON')
  }

  const outbox = typeof actor.outbox === 'string' ? actor.outbox : actor.outbox?.id
  if (!outbox || typeof outbox !== 'string') {
    throw new Error('Actor has no outbox URL')
  }

  const id = typeof actor.id === 'string' ? actor.id : actorUri
  const icon = extractImage(actor.icon)
  let host: string
  try { host = new URL(id).hostname } catch { throw new Error('Invalid actor id URI') }

  return {
    id,
    name: typeof actor.name === 'string' ? actor.name : null,
    preferredUsername: typeof actor.preferredUsername === 'string' ? actor.preferredUsername : null,
    summary: typeof actor.summary === 'string' ? stripHtml(actor.summary) : null,
    icon,
    outbox,
    url: typeof actor.url === 'string' ? actor.url : null,
    host,
  }
}

function extractImage(obj: any): string | null {
  if (!obj) return null
  if (typeof obj === 'string') return obj
  if (typeof obj.url === 'string') return obj.url
  if (Array.isArray(obj) && obj.length > 0) return extractImage(obj[0])
  return null
}

// =============================================================================
// Outbox pagination
//
// Mastodon's outbox is an OrderedCollection whose `first` is a URL (or inline
// page). Each page is an OrderedCollectionPage with `orderedItems` and a
// `next` URL. We paginate newest → oldest, stopping when we reach the
// cursor (the id of the newest item from the previous poll) or the cutoff.
// =============================================================================

export interface OutboxFetchOptions {
  outboxUrl: string
  cursor: string | null          // newest seen id URI from previous poll
  cutoffMs: number                // don't page older than this (epoch ms)
  maxPages: number
  itemsPerPage: number
}

export interface OutboxFetchResult {
  items: NormalisedActivityPubItem[]
  newCursor: string | null        // id of the newest item we saw this run
}

export async function fetchOutbox(
  actor: ActorMetadata,
  opts: OutboxFetchOptions
): Promise<OutboxFetchResult> {
  // First request resolves the collection → its first page.
  const firstPageUrl = await resolveFirstPageUrl(opts.outboxUrl, opts.itemsPerPage)

  const items: NormalisedActivityPubItem[] = []
  let nextUrl: string | null = firstPageUrl
  let newCursor: string | null = null
  let reachedCursor = false

  for (let page = 0; page < opts.maxPages && nextUrl && !reachedCursor; page++) {
    const res = await safeFetch(nextUrl, { headers: { 'Accept': AP_ACCEPT } })
    if (!res.ok) throw new Error(`Outbox page returned HTTP ${res.status}`)

    let body: any
    try { body = JSON.parse(res.text) } catch { throw new Error('Outbox page is not valid JSON') }

    const orderedItems: any[] = Array.isArray(body.orderedItems) ? body.orderedItems : []
    for (const activity of orderedItems) {
      const activityType = typeof activity?.type === 'string' ? activity.type : null
      const activityId = typeof activity?.id === 'string' ? activity.id : null

      // Cursor dedup: stop as soon as we see the previous newest.
      if (opts.cursor && activityId === opts.cursor) {
        reachedCursor = true
        break
      }
      if (newCursor === null && activityId) newCursor = activityId

      // We only ingest public Create→Note activities. Everything else
      // (Announce boosts, Update, Delete, Follow, Like) is out of scope
      // for read-only v1 ingestion.
      if (activityType !== 'Create') continue
      if (!isPublic(activity)) continue
      const note = activity.object
      if (!note || typeof note !== 'object') continue
      if (note.type !== 'Note' && note.type !== 'Article') continue
      if (!isPublic(note)) continue

      const publishedAt = parseDate(note.published) ?? parseDate(activity.published) ?? new Date()
      if (publishedAt.getTime() < opts.cutoffMs) {
        // Pages are newest-first; once we've crossed the cutoff we're done.
        reachedCursor = true
        break
      }

      const normalised = normaliseNote(actor, activity, note, publishedAt)
      if (normalised) items.push(normalised)
    }

    nextUrl = typeof body.next === 'string' ? body.next : null
  }

  return { items, newCursor }
}

async function resolveFirstPageUrl(outboxUrl: string, itemsPerPage: number): Promise<string> {
  const res = await safeFetch(outboxUrl, { headers: { 'Accept': AP_ACCEPT } })
  if (!res.ok) throw new Error(`Outbox returned HTTP ${res.status}`)
  let body: any
  try { body = JSON.parse(res.text) } catch { throw new Error('Outbox is not valid JSON') }

  // Some servers embed the first page inline; others return a URL.
  if (typeof body.first === 'string') {
    // Append a page size hint (Mastodon honours `?page=true&limit=...`).
    try {
      const u = new URL(body.first)
      if (!u.searchParams.has('limit')) u.searchParams.set('limit', String(itemsPerPage))
      return u.toString()
    } catch {
      return body.first
    }
  }
  if (body.first && typeof body.first === 'object' && typeof body.first.id === 'string') {
    return body.first.id
  }
  // Last resort: some instances only return OrderedCollectionPage directly.
  if (typeof body.id === 'string' && Array.isArray(body.orderedItems)) {
    return body.id
  }
  throw new Error('Outbox has no first page URL')
}

// =============================================================================
// Visibility — Mastodon marks public posts with `Public` in to/cc.
// =============================================================================

function isPublic(obj: any): boolean {
  const to = normaliseAudience(obj?.to)
  const cc = normaliseAudience(obj?.cc)
  return to.includes(PUBLIC_URI) || cc.includes(PUBLIC_URI)
}

function normaliseAudience(v: unknown): string[] {
  if (!v) return []
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

// =============================================================================
// Note normaliser
// =============================================================================

function normaliseNote(
  actor: ActorMetadata,
  activity: any,
  note: any,
  publishedAt: Date
): NormalisedActivityPubItem | null {
  const id = typeof note.id === 'string' ? note.id : null
  if (!id) return null

  const rawHtml = typeof note.content === 'string' ? note.content : ''
  const contentHtml = sanitizeContent(rawHtml)
  const contentText = stripHtml(rawHtml)

  const media = extractAttachments(note.attachment)
  const sourceReplyUri = typeof note.inReplyTo === 'string' ? note.inReplyTo : null

  const webUrl = typeof note.url === 'string' ? note.url : null
  const language = extractLanguage(note)

  return {
    sourceItemUri: id,
    authorName: actor.name,
    authorHandle: actor.preferredUsername ? `${actor.preferredUsername}@${actor.host}` : null,
    authorAvatarUrl: actor.icon,
    authorUri: actor.id,
    contentText,
    contentHtml,
    language,
    media,
    sourceReplyUri,
    sourceQuoteUri: null,
    publishedAt,
    webUrl,
    interactionData: {
      id,
      activityId: typeof activity?.id === 'string' ? activity.id : undefined,
      replyTo: sourceReplyUri ?? undefined,
      webUrl: webUrl ?? undefined,
    },
  }
}

function extractAttachments(raw: unknown): MediaAttachment[] {
  if (!raw) return []
  const arr = Array.isArray(raw) ? raw : [raw]
  const media: MediaAttachment[] = []
  for (const att of arr) {
    if (!att || typeof att !== 'object') continue
    const a: any = att
    const url = typeof a.url === 'string' ? a.url
      : typeof a.href === 'string' ? a.href
      : Array.isArray(a.url) && typeof a.url[0]?.href === 'string' ? a.url[0].href
      : null
    if (!url) continue
    const mime = typeof a.mediaType === 'string' ? a.mediaType : undefined
    const type = inferType(a.type, mime)
    media.push({
      type,
      url,
      thumbnail: extractImage(a.icon) ?? undefined,
      alt: typeof a.name === 'string' ? a.name : undefined,
      width: typeof a.width === 'number' ? a.width : undefined,
      height: typeof a.height === 'number' ? a.height : undefined,
      mime_type: mime,
    })
  }
  return media
}

function inferType(apType: unknown, mime: string | undefined): 'image' | 'video' | 'audio' | 'link' {
  const m = (mime ?? '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  const t = typeof apType === 'string' ? apType.toLowerCase() : ''
  if (t.includes('image')) return 'image'
  if (t.includes('video')) return 'video'
  if (t.includes('audio')) return 'audio'
  return 'link'
}

function extractLanguage(note: any): string | null {
  if (typeof note?.contentMap === 'object' && note.contentMap) {
    const keys = Object.keys(note.contentMap)
    if (keys.length > 0) return keys[0]
  }
  return null
}

function parseDate(s: unknown): Date | null {
  if (typeof s !== 'string') return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null
  return d
}
