import NDK, { NDKEvent, NDKFilter, NDKKind } from '@nostr-dev-kit/ndk'

// =============================================================================
// NDK Client — Nostr Development Kit singleton
//
// Connects to the platform relay (strfry) and provides typed helpers for
// fetching articles, notes, and vault events.
//
// The NDK instance is shared across the app. On the server side (RSC),
// a fresh instance is created per request. On the client side, a singleton
// is reused across navigations.
//
// Custom kinds used by platform.pub:
//   - 39701: Vault events (encrypted paywalled bodies)
//   - 9901:  Consumption receipts
// =============================================================================

const PLATFORM_RELAY = process.env.NEXT_PUBLIC_RELAY_URL ?? 'ws://localhost:4848'

// Custom kind constants (not in NDK's built-in enum)
export const KIND_VAULT = 39701
export const KIND_RECEIPT = 9901
export const KIND_ARTICLE = 30023
export const KIND_DRAFT = 30024
export const KIND_NOTE = 1
export const KIND_CONTACTS = 3
export const KIND_DELETION = 5
export const KIND_REACTION = 7

let clientNdk: NDK | null = null

export function getNdk(): NDK {
  if (typeof window === 'undefined') {
    // Server side — create fresh instance per request
    return createNdk()
  }

  // Client side — singleton
  if (!clientNdk) {
    clientNdk = createNdk()
    clientNdk.connect().catch(console.error)
  }

  return clientNdk
}

function createNdk(): NDK {
  return new NDK({
    explicitRelayUrls: [PLATFORM_RELAY],
    enableOutboxModel: false,  // single-relay at launch
  })
}

// =============================================================================
// Article helpers
// =============================================================================

export interface ArticleEvent {
  id: string
  pubkey: string
  dTag: string
  title: string
  summary: string
  content: string          // free section (pre-gate markdown)
  image?: string
  publishedAt: number
  tags: string[][]
  // Paywall metadata (from tags)
  pricePence?: number
  gatePositionPct?: number
  isPaywalled: boolean
  // Co-located encrypted body (new format — articles published after spec §III.2)
  // Absent on old articles; those use a separate kind 39701 vault event instead.
  encryptedPayload?: string    // base64 ciphertext from ['payload', ...] tag
  payloadAlgorithm?: string    // 'xchacha20poly1305' | 'aes-256-gcm'
}

export interface NoteEvent {
  type: 'note'
  id: string
  pubkey: string
  content: string
  publishedAt: number
  quotedEventId?: string
  quotedEventKind?: number
}

// Discriminated union for mixed-kind feeds
export type FeedItem =
  | (ArticleEvent & { type: 'article' })
  | NoteEvent

export function parseArticleEvent(event: NDKEvent): ArticleEvent {
  const dTag = event.tagValue('d') ?? ''
  const title = event.tagValue('title') ?? 'Untitled'
  const summary = event.tagValue('summary') ?? ''
  const image = event.tagValue('image') ?? undefined
  const publishedAt = event.tagValue('published_at')
    ? parseInt(event.tagValue('published_at')!, 10)
    : event.created_at ?? 0

  // Paywall info comes from the companion vault event's tags,
  // but the article event itself may carry price/gate hints
  const priceTag = event.tags.find((t) => t[0] === 'price')
  const gateTag = event.tags.find((t) => t[0] === 'gate')
  const payloadTag = event.tags.find((t) => t[0] === 'payload')

  return {
    id: event.id,
    pubkey: event.pubkey,
    dTag,
    title,
    summary,
    content: event.content,
    image,
    publishedAt,
    tags: event.tags,
    pricePence: priceTag ? parseInt(priceTag[1], 10) : undefined,
    gatePositionPct: gateTag ? parseInt(gateTag[1], 10) : undefined,
    isPaywalled: !!priceTag,
    encryptedPayload: payloadTag?.[1],
    payloadAlgorithm: payloadTag?.[2],
  }
}

export function parseNoteEvent(event: NDKEvent): NoteEvent {
  const qTag = event.tags.find(t => t[0] === 'q')
  return {
    type: 'note',
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    publishedAt: event.created_at ?? 0,
    quotedEventId: qTag?.[1],
  }
}

export async function fetchArticle(ndk: NDK, nostrEventId: string): Promise<ArticleEvent | null> {
  const event = await ndk.fetchEvent(nostrEventId)
  if (!event || event.kind !== KIND_ARTICLE) return null
  return parseArticleEvent(event)
}

export async function fetchArticleByDTag(
  ndk: NDK,
  pubkey: string,
  dTag: string
): Promise<ArticleEvent | null> {
  const filter: NDKFilter = {
    kinds: [KIND_ARTICLE as NDKKind],
    authors: [pubkey],
    '#d': [dTag],
  }

  const events = await ndk.fetchEvents(filter)
  const event = Array.from(events)[0]
  if (!event) return null
  return parseArticleEvent(event)
}

export async function fetchWriterArticles(
  ndk: NDK,
  pubkey: string,
  limit = 20
): Promise<ArticleEvent[]> {
  const filter: NDKFilter = {
    kinds: [KIND_ARTICLE as NDKKind],
    authors: [pubkey],
    limit,
  }

  const events = await ndk.fetchEvents(filter)
  return Array.from(events)
    .map(parseArticleEvent)
    .sort((a, b) => b.publishedAt - a.publishedAt)
}

// =============================================================================
// Vault event helpers
// =============================================================================

export interface VaultEvent {
  id: string
  dTag: string
  articleEventId: string
  ciphertext: string
  pricePence: number
  gatePositionPct: number
}

export async function fetchVaultEvent(
  ndk: NDK,
  articleDTag: string
): Promise<VaultEvent | null> {
  const filter: NDKFilter = {
    kinds: [KIND_VAULT as NDKKind],
    '#d': [articleDTag],
  }

  const events = await ndk.fetchEvents(filter)
  const event = Array.from(events)[0]
  if (!event) return null

  return {
    id: event.id,
    dTag: event.tagValue('d') ?? '',
    articleEventId: event.tagValue('e') ?? '',
    ciphertext: event.content,
    pricePence: parseInt(event.tags.find((t) => t[0] === 'price')?.[1] ?? '0', 10),
    gatePositionPct: parseInt(event.tags.find((t) => t[0] === 'gate')?.[1] ?? '50', 10),
  }
}
