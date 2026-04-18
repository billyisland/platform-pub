// =============================================================================
// Nostr Types & Constants
//
// Plain TypeScript types and kind constants for Nostr events used across the
// web client. No relay connection or NDK dependency — all relay communication
// goes through the gateway API.
// =============================================================================

// Nostr event kind constants
export const KIND_VAULT = 39701
export const KIND_RECEIPT = 9901
export const KIND_ARTICLE = 30023
export const KIND_DRAFT = 30024
export const KIND_NOTE = 1
export const KIND_CONTACTS = 3
export const KIND_DELETION = 5
export const KIND_REACTION = 7

// =============================================================================
// App-level event interfaces
// =============================================================================

export type PipStatus = 'known' | 'partial' | 'unknown'

export type SizeTier = 'lead' | 'standard' | 'brief'

export interface ArticleEvent {
  type?: 'article'
  id: string
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
}

export interface NoteEvent {
  type: 'note'
  id: string
  pubkey: string
  content: string
  publishedAt: number
  quotedEventId?: string
  quotedEventKind?: number
  quotedExcerpt?: string
  quotedTitle?: string
  quotedAuthor?: string
  pipStatus?: PipStatus
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
