import Parser from 'rss-parser'
import { safeFetch } from '@platform-pub/shared/lib/http-client.js'
import { sanitizeContent, stripHtml } from '../lib/sanitize.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// RSS / Atom ingestion adapter
//
// Fetches an RSS or Atom feed, parses items, and returns normalised rows
// ready for INSERT INTO external_items.
// =============================================================================

type RssItemExtras = {
  mediaContent: unknown
  mediaThumbnail: unknown
  'content:encoded'?: string
  author?: string
}

const parser = new Parser<unknown, RssItemExtras>({
  timeout: 10_000,
  maxRedirects: 3,
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      'content:encoded',
      'author',
    ],
  },
})

interface RssFetchOptions {
  feedUrl: string
  etag?: string | null
  lastModified?: string | null
}

interface RssFetchResult {
  items: NormalisedItem[]
  etag?: string
  lastModified?: string
  feedTitle?: string
  feedDescription?: string
  notModified: boolean
}

interface NormalisedItem {
  sourceItemUri: string
  authorName: string | null
  authorHandle: string | null
  authorUri: string | null
  contentText: string | null
  contentHtml: string | null
  summary: string | null
  title: string | null
  language: string | null
  media: MediaAttachment[]
  publishedAt: Date
}

interface MediaAttachment {
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

export async function fetchRssFeed(options: RssFetchOptions): Promise<RssFetchResult> {
  const headers: Record<string, string> = {
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.1',
  }
  if (options.etag) headers['If-None-Match'] = options.etag
  if (options.lastModified) headers['If-Modified-Since'] = options.lastModified

  const response = await safeFetch(options.feedUrl, { headers })

  if (response.status === 304) {
    return { items: [], notModified: true }
  }

  if (!response.ok) {
    throw new Error(`Feed returned HTTP ${response.status}`)
  }

  const feed = await parser.parseString(response.text)

  const items: NormalisedItem[] = []
  for (const entry of feed.items ?? []) {
    const guid = entry.guid ?? entry.link
    if (!guid) continue

    const rawHtml = entry['content:encoded'] ?? entry.content ?? entry.summary ?? ''
    const contentHtml = rawHtml ? sanitizeContent(rawHtml) : null
    const contentText = rawHtml ? stripHtml(rawHtml) : null
    const summaryText = entry.summary ? stripHtml(entry.summary) : null

    const media = extractMedia(entry)

    let publishedAt: Date
    try {
      publishedAt = entry.pubDate ? new Date(entry.pubDate) :
                    entry.isoDate ? new Date(entry.isoDate) :
                    new Date()
    } catch {
      publishedAt = new Date()
    }
    // Reject dates in the far future (likely parsing errors)
    if (publishedAt.getTime() > Date.now() + 86_400_000) {
      publishedAt = new Date()
    }

    items.push({
      sourceItemUri: guid,
      authorName: entry.creator ?? entry.author ?? null,
      authorHandle: null,
      authorUri: null,
      contentText,
      contentHtml,
      summary: summaryText,
      title: entry.title ?? null,
      language: null,
      media,
      publishedAt,
    })
  }

  return {
    items,
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
    feedTitle: feed.title ?? undefined,
    feedDescription: feed.description ?? undefined,
    notModified: false,
  }
}

function extractMedia(entry: any): MediaAttachment[] {
  const media: MediaAttachment[] = []

  // <enclosure> elements
  if (entry.enclosure) {
    const enc = entry.enclosure
    if (enc.url) {
      media.push({
        type: inferMediaType(enc.type ?? ''),
        url: enc.url,
        mime_type: enc.type ?? undefined,
      })
    }
  }

  // <media:content> elements
  if (Array.isArray(entry.mediaContent)) {
    for (const mc of entry.mediaContent) {
      const attrs = mc.$ ?? mc
      if (attrs.url) {
        media.push({
          type: inferMediaType(attrs.medium ?? attrs.type ?? ''),
          url: attrs.url,
          width: attrs.width ? parseInt(attrs.width, 10) : undefined,
          height: attrs.height ? parseInt(attrs.height, 10) : undefined,
          mime_type: attrs.type ?? undefined,
        })
      }
    }
  }

  // <media:thumbnail>
  if (entry.mediaThumbnail) {
    const thumb = entry.mediaThumbnail.$ ?? entry.mediaThumbnail
    if (thumb.url && media.length > 0) {
      media[0].thumbnail = thumb.url
    } else if (thumb.url) {
      media.push({ type: 'image', url: thumb.url })
    }
  }

  return media
}

function inferMediaType(hint: string): 'image' | 'video' | 'audio' | 'link' {
  const h = hint.toLowerCase()
  if (h.includes('image') || h === 'image') return 'image'
  if (h.includes('video') || h === 'video') return 'video'
  if (h.includes('audio') || h === 'audio') return 'audio'
  return 'link'
}
