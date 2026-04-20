import { RichText } from '@atproto/api'
import { sanitizeContent } from '../lib/sanitize.js'

// =============================================================================
// AT Protocol (Bluesky) normaliser
//
// Takes a Jetstream commit event for app.bsky.feed.post and produces the
// fields needed for external_items + feed_items. See docs/adr/UNIVERSAL-FEED-ADR.md
// §V.3 and §VI.3.
//
// Jetstream commit shape (subset we care about):
//   {
//     did: 'did:plc:...',
//     time_us: 1712000000000000,
//     kind: 'commit',
//     commit: {
//       operation: 'create' | 'update' | 'delete',
//       collection: 'app.bsky.feed.post',
//       rkey: '3l...',
//       cid: 'bafy...',
//       record: { $type, text, createdAt, reply?, embed?, facets?, langs? }
//     }
//   }
// =============================================================================

export interface JetstreamCommit {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account'
  commit?: {
    rev?: string
    operation: 'create' | 'update' | 'delete'
    collection: string
    rkey: string
    cid?: string
    record?: BskyPostRecord
  }
}

// Exported for the backfill task (FeedViewPost.record is the same shape)
export interface BskyPostRecord {
  $type: 'app.bsky.feed.post'
  text: string
  createdAt: string
  langs?: string[]
  facets?: BskyFacet[]
  reply?: {
    root: { uri: string; cid: string }
    parent: { uri: string; cid: string }
  }
  embed?: BskyEmbed
}

interface BskyFacet {
  index: { byteStart: number; byteEnd: number }
  features: Array<
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#mention'; did: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >
}

type BskyEmbed =
  | BskyImagesEmbed
  | BskyExternalEmbed
  | BskyRecordEmbed
  | BskyRecordWithMediaEmbed
  | BskyVideoEmbed

interface BskyImagesEmbed {
  $type: 'app.bsky.embed.images'
  images: Array<{
    image: BlobRef
    alt: string
    aspectRatio?: { width: number; height: number }
  }>
}

interface BskyExternalEmbed {
  $type: 'app.bsky.embed.external'
  external: {
    uri: string
    title: string
    description: string
    thumb?: BlobRef
  }
}

interface BskyRecordEmbed {
  $type: 'app.bsky.embed.record'
  record: { uri: string; cid: string }
}

interface BskyRecordWithMediaEmbed {
  $type: 'app.bsky.embed.recordWithMedia'
  record: { record: { uri: string; cid: string } }
  media: BskyImagesEmbed | BskyExternalEmbed | BskyVideoEmbed
}

interface BskyVideoEmbed {
  $type: 'app.bsky.embed.video'
  video: BlobRef
  alt?: string
  aspectRatio?: { width: number; height: number }
}

interface BlobRef {
  $type?: 'blob'
  ref?: { $link: string } | string
  mimeType?: string
  size?: number
}

export interface MediaAttachment {
  type: 'image' | 'video' | 'link'
  url: string
  thumbnail?: string
  alt?: string
  width?: number
  height?: number
  mime_type?: string
  title?: string
  description?: string
}

export interface NormalisedAtprotoItem {
  sourceItemUri: string
  contentText: string
  contentHtml: string
  media: MediaAttachment[]
  publishedAt: Date
  language: string | null
  sourceReplyUri: string | null
  sourceQuoteUri: string | null
  isRepost: boolean
  interactionData: {
    uri: string
    cid: string | null
    rootUri?: string
    rootCid?: string
    parentUri?: string
    parentCid?: string
  }
}

// =============================================================================
// Build an at:// URI from DID and record key
// =============================================================================

export function buildAtUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}

// =============================================================================
// CDN URL for a Bluesky blob. Bluesky exposes images through a public CDN
// keyed by the author's DID and the blob's CID. The image service supports
// sized variants (feed_thumbnail, feed_fullsize, avatar). We default to
// feed_fullsize for post images and avatar for profile pictures.
// =============================================================================

const BSKY_CDN = 'https://cdn.bsky.app/img'

function blobCid(ref: BlobRef | undefined): string | null {
  if (!ref?.ref) return null
  return typeof ref.ref === 'string' ? ref.ref : ref.ref.$link
}

function cdnImageUrl(did: string, ref: BlobRef | undefined, size: 'feed_fullsize' | 'feed_thumbnail' = 'feed_fullsize'): string | null {
  const cid = blobCid(ref)
  if (!cid) return null
  return `${BSKY_CDN}/${size}/plain/${did}/${cid}@jpeg`
}

// =============================================================================
// Render post text + facets into sanitised HTML. Mentions become profile
// links, links become anchors, tags become search links. RichText from
// @atproto/api handles UTF-16 vs byte-offset conversion correctly.
// =============================================================================

function renderHtml(record: BskyPostRecord): string {
  // Facets carry an AT Protocol `[k: string]: unknown` index signature in
  // the @atproto/api types; ours is a narrower subset. Cast through unknown
  // to preserve the real value at runtime.
  const rt = new RichText({
    text: record.text,
    facets: record.facets as unknown as ConstructorParameters<typeof RichText>[0]['facets'],
  })
  const parts: string[] = []
  for (const segment of rt.segments()) {
    const text = escapeHtml(segment.text)
    if (segment.isLink() && segment.link) {
      parts.push(`<a href="${escapeAttr(segment.link.uri)}" rel="nofollow noopener">${text}</a>`)
    } else if (segment.isMention() && segment.mention) {
      parts.push(`<a href="https://bsky.app/profile/${escapeAttr(segment.mention.did)}" rel="nofollow noopener">${text}</a>`)
    } else if (segment.isTag() && segment.tag) {
      parts.push(`<a href="https://bsky.app/hashtag/${escapeAttr(segment.tag.tag)}" rel="nofollow noopener">${text}</a>`)
    } else {
      parts.push(text)
    }
  }
  // Every element emitted above comes from our allowlist (<a href=…> + <br>),
  // but run the output through the shared sanitiser so the Bluesky adapter
  // tracks the same rules as RSS and ActivityPub. If we ever broaden the
  // RichText walk (embeds, mentions with arbitrary URIs), the sanitiser is
  // already in the path.
  return sanitizeContent(parts.join('').replace(/\n/g, '<br>'))
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  )
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;')
}

// =============================================================================
// Extract media attachments and quote target from an embed.
// =============================================================================

function extractMedia(did: string, embed: BskyEmbed | undefined): { media: MediaAttachment[]; sourceQuoteUri: string | null } {
  if (!embed) return { media: [], sourceQuoteUri: null }

  const media: MediaAttachment[] = []
  let sourceQuoteUri: string | null = null

  const appendImages = (imgs: BskyImagesEmbed) => {
    for (const img of imgs.images) {
      const url = cdnImageUrl(did, img.image, 'feed_fullsize')
      const thumb = cdnImageUrl(did, img.image, 'feed_thumbnail')
      if (!url) continue
      media.push({
        type: 'image',
        url,
        thumbnail: thumb ?? undefined,
        alt: img.alt || undefined,
        width: img.aspectRatio?.width,
        height: img.aspectRatio?.height,
        mime_type: img.image.mimeType,
      })
    }
  }

  const appendExternal = (ext: BskyExternalEmbed) => {
    const thumb = cdnImageUrl(did, ext.external.thumb, 'feed_thumbnail')
    media.push({
      type: 'link',
      url: ext.external.uri,
      thumbnail: thumb ?? undefined,
      title: ext.external.title || undefined,
      description: ext.external.description || undefined,
    })
  }

  const appendVideo = (vid: BskyVideoEmbed) => {
    const cid = blobCid(vid.video)
    if (!cid) return
    media.push({
      type: 'video',
      url: `https://video.bsky.app/watch/${did}/${cid}/playlist.m3u8`,
      alt: vid.alt || undefined,
      width: vid.aspectRatio?.width,
      height: vid.aspectRatio?.height,
      mime_type: vid.video.mimeType,
    })
  }

  switch (embed.$type) {
    case 'app.bsky.embed.images':
      appendImages(embed)
      break
    case 'app.bsky.embed.external':
      appendExternal(embed)
      break
    case 'app.bsky.embed.video':
      appendVideo(embed)
      break
    case 'app.bsky.embed.record':
      sourceQuoteUri = embed.record.uri
      break
    case 'app.bsky.embed.recordWithMedia':
      sourceQuoteUri = embed.record.record.uri
      if (embed.media.$type === 'app.bsky.embed.images') appendImages(embed.media)
      else if (embed.media.$type === 'app.bsky.embed.external') appendExternal(embed.media)
      else if (embed.media.$type === 'app.bsky.embed.video') appendVideo(embed.media)
      break
  }

  return { media, sourceQuoteUri }
}

// =============================================================================
// Main entry: normalise a Jetstream create/update commit into item fields.
// Returns null if the commit isn't a post we want to ingest.
// =============================================================================

export function normaliseAtprotoCommit(event: JetstreamCommit): NormalisedAtprotoItem | null {
  const commit = event.commit
  if (!commit) return null
  if (commit.collection !== 'app.bsky.feed.post') return null
  if (commit.operation !== 'create' && commit.operation !== 'update') return null
  if (!commit.record) return null

  const sourceItemUri = buildAtUri(event.did, commit.collection, commit.rkey)
  const fallbackDate = new Date(event.time_us / 1000)
  return normaliseAtprotoPost({
    did: event.did,
    uri: sourceItemUri,
    cid: commit.cid ?? null,
    record: commit.record,
    fallbackDate,
  })
}

// =============================================================================
// Shared normaliser — used by both the Jetstream listener and the backfill
// job (which loads posts via app.bsky.feed.getAuthorFeed and provides an
// already-built URI + CID).
// =============================================================================

export function normaliseAtprotoPost(args: {
  did: string
  uri: string
  cid: string | null
  record: BskyPostRecord
  fallbackDate: Date
}): NormalisedAtprotoItem {
  const { did, uri, cid, record, fallbackDate } = args
  const { media, sourceQuoteUri } = extractMedia(did, record.embed)
  const publishedAt = parseCreatedAt(record.createdAt) ?? fallbackDate

  return {
    sourceItemUri: uri,
    contentText: record.text,
    contentHtml: renderHtml(record),
    media,
    publishedAt,
    language: record.langs?.[0] ?? null,
    sourceReplyUri: record.reply?.parent.uri ?? null,
    sourceQuoteUri,
    isRepost: false,
    interactionData: {
      uri,
      cid,
      rootUri: record.reply?.root.uri,
      rootCid: record.reply?.root.cid,
      parentUri: record.reply?.parent.uri,
      parentCid: record.reply?.parent.cid,
    },
  }
}

function parseCreatedAt(s: string | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  // Reject absurd future timestamps (clock-skewed clients).
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null
  return d
}
