// =============================================================================
// Nostr Types & Constants
//
// Plain TypeScript types and kind constants for Nostr events used across the
// web client. No relay connection or NDK dependency — all relay communication
// goes through the gateway API.
// =============================================================================

// Nostr event kind constants
export const KIND_ARTICLE = 30023
export const KIND_NOTE = 1
export const KIND_DELETION = 5

// =============================================================================
// App-level event interfaces
// =============================================================================

export type PipStatus = 'known' | 'partial' | 'unknown' | 'contested'

export type SizeTier = 'lead' | 'standard' | 'brief'

export interface ArticleEvent {
  type?: 'article'
  id: string
  // feedItemId — the feed_items.id key (slice 20). Optional because Article
  // surfaces outside the workspace feed (reading view, profile pages) build
  // ArticleEvent objects without going through the unified table.
  feedItemId?: string
  pubkey: string
  dTag: string
  title: string
  summary: string
  content: string
  publishedAt: number
  tags: string[][]
  topicTags?: string[]
  pricePence?: number
  gatePositionPct?: number
  isPaywalled?: boolean
  encryptedPayload?: string
  payloadAlgorithm?: string
  pipStatus?: PipStatus
  sizeTier?: SizeTier
  // Slice 20: present in the saved-items view, absent in the live view.
  savedAt?: number
  // Slice 23b: cover image, served as feed_items.media shape so the
  // workspace MediaBlock consumes it without translation.
  media?: Array<{
    type: 'image' | 'video' | 'audio' | 'link'
    url: string
    thumbnail?: string
    alt?: string
    width?: number
    height?: number
    title?: string
    description?: string
  }>
}

export interface NoteEvent {
  type: 'note'
  id: string
  feedItemId?: string
  pubkey: string
  content: string
  publishedAt: number
  quotedEventId?: string
  quotedEventKind?: number
  quotedExcerpt?: string
  quotedTitle?: string
  quotedAuthor?: string
  pipStatus?: PipStatus
  savedAt?: number
}

export interface VaultEvent {
  id: string
  pubkey: string
  dTag: string
  ciphertext: string
  algorithm: string
}

export interface ExternalFeedItem {
  type: 'external'
  id: string
  feedItemId?: string
  savedAt?: number
  sourceProtocol: string
  sourceItemUri: string
  authorName: string | null
  authorHandle: string | null
  authorAvatarUrl: string | null
  authorUri: string | null
  contentText: string | null
  contentHtml: string | null
  title: string | null
  summary: string | null
  media: Array<{
    type: 'image' | 'video' | 'audio' | 'link'
    url: string
    thumbnail?: string
    alt?: string
    width?: number
    height?: number
    title?: string
    description?: string
  }>
  publishedAt: number
  sourceName: string | null
  sourceAvatar: string | null
  pipStatus?: PipStatus
}

export type FeedItem = (ArticleEvent & { type: 'article' }) | NoteEvent | ExternalFeedItem
