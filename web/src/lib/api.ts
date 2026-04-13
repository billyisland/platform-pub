// =============================================================================
// API Client
//
// Typed fetch wrappers for the gateway API. All requests include credentials
// (cookies) automatically. Runs client-side only.
//
// The Next.js rewrites in next.config.js proxy /api/* to the gateway,
// so these calls work in both dev and production.
// =============================================================================

const API_BASE = '/api/v1'

class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(`API error ${status}: ${JSON.stringify(body)}`)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers as Record<string, string> }
  if (options.body) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers,
  })

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    throw new ApiError(res.status, body)
  }

  return body as T
}

// =============================================================================
// Auth
// =============================================================================

export interface SignupInput {
  email: string
  displayName: string
  username: string
}

export interface SignupResult {
  accountId: string
  pubkey: string
  username: string
}

export interface MeResponse {
  id: string
  pubkey: string
  username: string | null
  displayName: string | null
  bio: string | null
  avatar: string | null
  isWriter: boolean
  hasPaymentMethod: boolean
  stripeConnectKycComplete: boolean
  freeAllowanceRemainingPence: number
  defaultArticlePricePence: number | null
  isAdmin: boolean
}

export const auth = {
  signup: (input: SignupInput) =>
    request<SignupResult>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  login: (email: string) =>
    request<{ message: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  devLogin: (email: string) =>
    request<{ id: string; username: string; displayName: string }>('/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  verify: (token: string) =>
    request<{ id: string; username: string; displayName: string }>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  logout: () =>
    request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<MeResponse>('/auth/me'),

  connectStripe: () =>
    request<{ stripeConnectUrl: string }>('/auth/upgrade-writer', { method: 'POST' }),

  connectCard: (paymentMethodId: string) =>
    request<{ ok: boolean; hasPaymentMethod: boolean }>('/auth/connect-card', {
      method: 'POST',
      body: JSON.stringify({ paymentMethodId }),
    }),

  updateProfile: (data: { displayName?: string; bio?: string; avatar?: string | null }) =>
    request<{ ok: boolean }>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
}

// =============================================================================
// Payment / Reading
// =============================================================================

export interface WriterEarnings {
  writerId: string
  earningsTotalPence: number
  pendingTransferPence: number
  paidOutPence: number
  readCount: number
}

export interface ArticleEarnings {
  articleId: string
  title: string
  dTag: string
  publishedAt: string | null
  readCount: number
  netEarningsPence: number
  pendingPence: number
  paidPence: number
}

export interface GatePassResponse {
  readEventId: string
  allowanceJustExhausted?: boolean
  readState: string
  encryptedKey: string
  algorithm: string
  isReissuance: boolean
  ciphertext?: string          // base64-encoded encrypted body (from vault_keys)
}

export const payment = {
  getEarnings: (writerId: string) =>
    request<WriterEarnings>(`/earnings/${writerId}`),

  getPerArticleEarnings: (writerId: string) =>
    request<{ articles: ArticleEarnings[] }>(`/earnings/${writerId}/articles`),
}

// =============================================================================
// Articles
// =============================================================================

export interface ArticleMetadata {
  id: string
  nostrEventId: string
  dTag: string
  title: string
  slug: string
  summary: string | null
  contentFree: string | null
  wordCount: number | null
  isPaywalled: boolean
  pricePence: number | null
  gatePositionPct: number | null
  vaultEventId: string | null
  publishedAt: string | null
  writerSpendThisMonthPence: number | null
  nudgeShownThisMonth: boolean
  writer: {
    id: string
    username: string
    displayName: string | null
    avatar: string | null
    pubkey: string
    subscriptionPricePence?: number
  }
  publication: {
    id: string
    slug: string
    name: string
    subscriptionPricePence: number | null
  } | null
}

export const articles = {
  getByDTag: (dTag: string) =>
    request<ArticleMetadata>(`/articles/${dTag}`),

  gatePass: (nostrEventId: string) =>
    request<GatePassResponse>(`/articles/${nostrEventId}/gate-pass`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  index: (data: {
    nostrEventId: string
    dTag: string
    title: string
    summary?: string
    content: string
    accessMode: 'public' | 'paywalled' | 'invitation_only'
    pricePence: number
    gatePositionPct: number
    vaultEventId?: string
    draftId?: string
    sendEmail?: boolean
  }) =>
    request<{ articleId: string }>('/articles', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  togglePin: (articleId: string) =>
    request<{ pinned: boolean }>(`/articles/${articleId}/pin`, { method: 'POST' }),
}

// =============================================================================
// Key Service (via gateway proxy)
// =============================================================================

export interface KeyResponse {
  encryptedKey: string
  articleNostrEventId: string
  algorithm: string
  isReissuance: boolean
}

export const keys = {
  requestKey: (nostrEventId: string) =>
    request<KeyResponse>(`/articles/${nostrEventId}/key`, {
      method: 'POST',
    }),

  unwrapKey: (encryptedKey: string) =>
    request<{ contentKeyBase64: string }>('/unwrap-key', {
      method: 'POST',
      body: JSON.stringify({ encryptedKey }),
    }),
}

// =============================================================================
// Content Resolution
// =============================================================================

export interface ResolvedContent {
  type: 'note' | 'article'
  eventId: string
  content?: string
  title?: string
  dTag?: string
  accessMode?: string
  isPaywalled?: boolean
  publishedAt: number
  author: {
    username: string
    displayName: string | null
    avatar: string | null
  }
}

export const content = {
  resolve: (eventId: string) =>
    request<ResolvedContent>(`/content/resolve?eventId=${encodeURIComponent(eventId)}`),
}

// =============================================================================
// Feed
// =============================================================================

export type FeedReach = 'following' | 'explore'

export const feed = {
  get: (reach: FeedReach, cursor?: number, limit?: number) =>
    request<{ items: any[]; reach: FeedReach }>(
      `/feed?reach=${reach}${cursor ? `&cursor=${cursor}` : ''}${limit ? `&limit=${limit}` : ''}`
    ),
}

// =============================================================================
// Follows
// =============================================================================

export const follows = {
  follow: (writerId: string) =>
    request<{ ok: boolean }>(`/follows/${writerId}`, { method: 'POST' }),

  pubkeys: () =>
    request<{ pubkeys: string[] }>('/follows/pubkeys'),
}

// =============================================================================
// Search
// =============================================================================

export const search = {
  writers: (q: string, limit = 10) =>
    request<{ writers: any[] }>(`/search?type=writers&q=${encodeURIComponent(q)}&limit=${limit}`),
}

// =============================================================================
// Writers (public)
// =============================================================================

export interface WriterProfile {
  id: string
  pubkey: string
  username: string
  displayName: string | null
  bio: string | null
  avatar: string | null
  hostingType: string
  subscriptionPricePence: number
  annualDiscountPct: number
  showCommissionButton: boolean
  articleCount: number
  hasPaywalledArticle: boolean
  followerCount: number
  followingCount: number
}

export interface ProfileFollower {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  pubkey: string
  isWriter: boolean
  followedAt: string
}

export interface ProfileFollowing {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  pubkey: string
  followedAt: string
}

export interface PublicSubscription {
  writerId: string
  writerUsername: string
  writerDisplayName: string | null
  writerAvatar: string | null
  startedAt: string
}

export const writers = {
  getProfile: (username: string) =>
    request<WriterProfile>(`/writers/${username}`),

  getArticles: (username: string, limit = 20, offset = 0) =>
    request<{ articles: any[]; limit: number; offset: number }>(
      `/writers/${username}/articles?limit=${limit}&offset=${offset}`
    ),

  getFollowers: (username: string, limit = 20, offset = 0) =>
    request<{ followers: ProfileFollower[]; total: number; limit: number; offset: number }>(
      `/writers/${username}/followers?limit=${limit}&offset=${offset}`
    ),

  getFollowing: (username: string, limit = 20, offset = 0) =>
    request<{ following: ProfileFollowing[]; total: number; limit: number; offset: number }>(
      `/writers/${username}/following?limit=${limit}&offset=${offset}`
    ),

  getSubscriptions: (username: string, limit = 20, offset = 0) =>
    request<{ subscriptions: PublicSubscription[]; limit: number; offset: number }>(
      `/writers/${username}/subscriptions?limit=${limit}&offset=${offset}`
    ),
}

// =============================================================================
// Replies
// =============================================================================

export interface ReplyResponse {
  comments: any[]
  totalCount: number
  repliesEnabled: boolean
  commentsEnabled: boolean // backwards-compat alias
  paywallLocked?: boolean
}

export const replies = {
  getForTarget: (targetEventId: string) =>
    request<ReplyResponse>(`/replies/${targetEventId}`),

  deleteReply: (replyId: string) =>
    request<{ ok: boolean }>(`/replies/${replyId}`, { method: 'DELETE' }),

  toggleArticleReplies: (articleId: string, enabled: boolean) =>
    request<{ ok: boolean }>(`/articles/${articleId}/replies`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  toggleNoteReplies: (noteId: string, enabled: boolean) =>
    request<{ ok: boolean }>(`/notes/${noteId}/replies`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
}

// =============================================================================
// Article Management (editorial dashboard)
// =============================================================================

export interface MyArticle {
  id: string
  title: string
  slug: string
  dTag: string
  nostrEventId: string
  isPaywalled: boolean
  pricePence: number | null
  wordCount: number | null
  publishedAt: string | null
  repliesEnabled: boolean
  replyCount: number
  readCount: number
  netEarningsPence: number
}

export const myArticles = {
  list: () =>
    request<{ articles: MyArticle[] }>('/my/articles'),

  update: (articleId: string, data: { repliesEnabled?: boolean }) =>
    request<{ ok: boolean }>(`/articles/${articleId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  remove: (articleId: string) =>
    request<{ ok: boolean; deletedArticleId: string; nostrEventId: string; dTag: string }>(
      `/articles/${articleId}`,
      { method: 'DELETE' }
    ),

  unpublish: (articleId: string) =>
    request<{ ok: boolean }>(`/articles/${articleId}/unpublish`, { method: 'POST' }),
}

// =============================================================================
// Bookmarks
// =============================================================================

export interface BookmarkedArticle {
  id: string
  nostr_event_id: string
  nostr_d_tag: string
  title: string
  slug: string
  summary: string | null
  word_count: number | null
  access_mode: string
  price_pence: number | null
  published_at: string
  author_username: string
  author_display_name: string | null
  author_pubkey: string
  author_avatar: string | null
  bookmarked_at: string
}

export const bookmarks = {
  add: (nostrEventId: string) =>
    request<{ ok: boolean }>(`/bookmarks/${nostrEventId}`, { method: 'POST' }),

  remove: (nostrEventId: string) =>
    request<{ ok: boolean }>(`/bookmarks/${nostrEventId}`, { method: 'DELETE' }),

  list: (limit = 20, offset = 0) =>
    request<{ articles: BookmarkedArticle[]; hasMore: boolean }>(
      `/bookmarks?limit=${limit}&offset=${offset}`
    ),

  ids: () =>
    request<{ eventIds: string[] }>('/bookmarks/ids'),
}

// =============================================================================
// Tags
// =============================================================================

export interface TagSuggestion {
  name: string
  count: number
}

export const tags = {
  search: (q: string) =>
    request<{ tags: TagSuggestion[] }>(`/tags/search?q=${encodeURIComponent(q)}`),

  getByName: (name: string, limit = 20, offset = 0) =>
    request<{ tag: string; articles: any[]; total: number }>(
      `/tags/${encodeURIComponent(name)}?limit=${limit}&offset=${offset}`
    ),

  getForArticle: (articleId: string) =>
    request<{ tags: string[] }>(`/articles/${articleId}/tags`),

  setForArticle: (articleId: string, tagNames: string[]) =>
    request<{ ok: boolean; tags: string[] }>(`/articles/${articleId}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tags: tagNames }),
    }),
}

// =============================================================================
// Reading History
// =============================================================================

export interface ReadingHistoryItem {
  articleId: string
  readAt: string
  title: string | null
  slug: string | null
  dTag: string | null
  wordCount: number | null
  isPaywalled: boolean
  writer: {
    username: string | null
    displayName: string | null
    avatar: string | null
  }
}

export const readingHistory = {
  list: (limit = 50, offset = 0) =>
    request<{ items: ReadingHistoryItem[] }>(`/my/reading-history?limit=${limit}&offset=${offset}`),
}

// =============================================================================
// Notifications
// =============================================================================

export interface NotificationActor {
  id: string
  username: string | null
  displayName: string | null
  avatar: string | null
}

export type NotificationType =
  | 'new_follower'
  | 'new_reply'
  | 'new_subscriber'
  | 'new_quote'
  | 'new_mention'
  | 'commission_request'
  | 'drive_funded'
  | 'pledge_fulfilled'
  | 'new_message'
  | 'pub_article_submitted'
  | 'pub_article_published'
  | 'pub_new_subscriber'
  | 'pub_invite_received'
  | 'pub_member_joined'
  | 'pub_member_left'

export interface Notification {
  id: string
  type: NotificationType
  read: boolean
  createdAt: string
  actor: NotificationActor | null
  article: { id: string; title: string | null; slug: string | null; writerUsername: string | null } | null
  note: { id: string; nostrEventId: string | null } | null
  comment: { id: string; content: string | null } | null
  conversationId?: string
  driveId?: string
}

export const notifications = {
  list: (cursor?: string) => {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    const qs = params.toString()
    return request<{ notifications: Notification[]; unreadCount: number; nextCursor: string | null }>(
      `/notifications${qs ? `?${qs}` : ''}`
    )
  },

  markRead: (id: string) =>
    request<{ ok: boolean }>(`/notifications/${id}/read`, { method: 'POST' }),

  readAll: () =>
    request<{ ok: boolean }>('/notifications/read-all', { method: 'POST' }),

  unreadCounts: () =>
    request<{ dmCount: number; notificationCount: number }>('/unread-counts'),

  getPreferences: () =>
    request<{ preferences: Record<string, boolean> }>('/notifications/preferences'),

  setPreference: (category: string, enabled: boolean) =>
    request<{ ok: boolean }>(`/notifications/preferences/${category}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
}

// =============================================================================
// Votes
// =============================================================================

export interface VoteTally {
  upvoteCount: number
  downvoteCount: number
  netScore: number
}

export interface MyVoteCount {
  upCount: number
  downCount: number
}

export const votes = {
  cast: (targetEventId: string, targetKind: number, direction: 'up' | 'down') =>
    request<{
      ok: boolean
      sequenceNumber: number
      costPence: number
      nextCostPence: number
      tally: VoteTally
    }>('/votes', {
      method: 'POST',
      body: JSON.stringify({ targetEventId, targetKind, direction }),
    }),

  getTallies: (eventIds: string[]) =>
    request<{ tallies: Record<string, VoteTally> }>(
      `/votes/tally?eventIds=${eventIds.join(',')}`
    ),

  getMyVotes: (eventIds: string[]) =>
    request<{ voteCounts: Record<string, MyVoteCount> }>(
      `/votes/mine?eventIds=${eventIds.join(',')}`
    ),

  getPrice: (eventId: string, direction: 'up' | 'down') =>
    request<{ sequenceNumber: number; costPence: number; direction: string }>(
      `/votes/price?eventId=${encodeURIComponent(eventId)}&direction=${direction}`
    ),
}

// =============================================================================
// Messages (Direct Messages)
// =============================================================================

export interface Conversation {
  id: string
  lastMessage: { content: string; senderUsername: string; createdAt: string } | null
  unreadCount: number
  members: { id: string; username: string; displayName: string | null; avatar: string | null }[]
}

export interface ReplyTo {
  id: string
  senderUsername: string | null
  contentEnc: string | null
  counterpartyPubkey: string | null
}

export interface DirectMessage {
  id: string
  conversationId: string
  senderId: string
  senderUsername: string
  senderDisplayName: string | null
  counterpartyPubkey: string
  contentEnc: string
  replyTo: ReplyTo | null
  readAt: string | null
  createdAt: string
  likeCount: number
  likedByMe: boolean
}

export interface DecryptedMessage extends DirectMessage {
  content: string | null
  replyToContent: string | null
}

export const messages = {
  listConversations: () =>
    request<{ conversations: Conversation[] }>('/messages'),

  getMessages: (conversationId: string, before?: string) =>
    request<{ messages: DirectMessage[]; nextCursor: string | null }>(
      `/messages/${conversationId}${before ? `?before=${before}` : ''}`
    ),

  send: (conversationId: string, content: string, replyToId?: string) =>
    request<{ messageIds: string[] }>(`/messages/${conversationId}`, {
      method: 'POST',
      body: JSON.stringify({ content, ...(replyToId && { replyToId }) }),
    }),

  markRead: (messageId: string) =>
    request<void>(`/messages/${messageId}/read`, { method: 'POST' }),

  markAllRead: (conversationId: string) =>
    request<{ ok: boolean; markedRead: number }>(`/messages/${conversationId}/read-all`, { method: 'POST' }),

  toggleLike: (messageId: string) =>
    request<{ liked: boolean }>(`/messages/${messageId}/like`, { method: 'POST' }),

  createConversation: (memberIds: string[]) =>
    request<{ conversationId: string }>('/conversations', {
      method: 'POST',
      body: JSON.stringify({ memberIds }),
    }),

  decryptBatch: (msgs: { id: string; counterpartyPubkey: string; ciphertext: string }[]) =>
    request<{ results: { id: string; plaintext: string | null; error?: string }[] }>('/dm/decrypt-batch', {
      method: 'POST',
      body: JSON.stringify({ messages: msgs }),
    }),
}

// =============================================================================
// DM Pricing
// =============================================================================

export interface DmPricingOverride {
  userId: string
  username: string
  displayName: string | null
  pricePence: number
}

export const dmPricing = {
  get: () =>
    request<{ defaultPricePence: number; overrides: DmPricingOverride[] }>('/settings/dm-pricing'),

  update: (defaultPricePence: number) =>
    request<{ ok: boolean }>('/settings/dm-pricing', {
      method: 'PUT',
      body: JSON.stringify({ defaultPricePence }),
    }),

  setOverride: (userId: string, pricePence: number) =>
    request<{ ok: boolean }>(`/settings/dm-pricing/override/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ pricePence }),
    }),

  removeOverride: (userId: string) =>
    request<{ ok: boolean }>(`/settings/dm-pricing/override/${userId}`, {
      method: 'DELETE',
    }),
}

// =============================================================================
// Blocks & Mutes
// =============================================================================

export interface BlockedUser {
  userId: string
  username: string
  displayName: string | null
  avatar: string | null
  blockedAt: string
}

export interface MutedUser {
  userId: string
  username: string
  displayName: string | null
  avatar: string | null
  mutedAt: string
}

export const social = {
  listBlocks: () =>
    request<{ blocks: BlockedUser[] }>('/my/blocks'),

  block: (userId: string) =>
    request<{ ok: boolean }>(`/my/blocks/${userId}`, { method: 'POST' }),

  unblock: (userId: string) =>
    request<{ ok: boolean }>(`/my/blocks/${userId}`, { method: 'DELETE' }),

  listMutes: () =>
    request<{ mutes: MutedUser[] }>('/my/mutes'),

  mute: (userId: string) =>
    request<{ ok: boolean }>(`/my/mutes/${userId}`, { method: 'POST' }),

  unmute: (userId: string) =>
    request<{ ok: boolean }>(`/my/mutes/${userId}`, { method: 'DELETE' }),
}

// =============================================================================
// Pledge Drives
// =============================================================================

export interface PledgeDrive {
  id: string
  origin: 'crowdfund' | 'commission'
  title: string
  description: string | null
  fundingTargetPence: number | null
  currentTotalPence: number
  pledgeCount: number
  status: 'open' | 'funded' | 'published' | 'fulfilled' | 'expired' | 'cancelled'
  pinned: boolean
  deadline: string | null
  createdAt: string
}

export interface Pledge {
  id: string
  driveId: string
  driveTitle: string
  driveStatus: string
  writer: { username: string; displayName: string | null }
  amountPence: number
  status: string
  createdAt: string
}

export const drives = {
  create: (data: {
    origin: 'crowdfund' | 'commission'
    title: string
    description?: string
    fundingTargetPence?: number
    suggestedPricePence?: number
    targetWriterId?: string
    parentNoteEventId?: string
    parentConversationId?: string
  }) =>
    request<{ driveId: string }>('/drives', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (id: string) =>
    request<PledgeDrive>(`/drives/${id}`),

  update: (id: string, data: { title?: string; description?: string; fundingTargetPence?: number }) =>
    request<{ ok: boolean }>(`/drives/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  cancel: (id: string) =>
    request<{ ok: boolean }>(`/drives/${id}`, { method: 'DELETE' }),

  pledge: (id: string, amountPence: number) =>
    request<{ pledgeId: string }>(`/drives/${id}/pledge`, {
      method: 'POST',
      body: JSON.stringify({ amountPence }),
    }),

  withdrawPledge: (id: string) =>
    request<{ ok: boolean }>(`/drives/${id}/pledge`, { method: 'DELETE' }),

  accept: (id: string, terms?: { acceptanceTerms?: string; backerAccessMode?: 'free' | 'paywalled'; deadline?: string }) =>
    request<{ ok: boolean }>(`/drives/${id}/accept`, {
      method: 'POST',
      body: JSON.stringify(terms ?? {}),
    }),

  decline: (id: string) =>
    request<{ ok: boolean }>(`/drives/${id}/decline`, { method: 'POST' }),

  togglePin: (id: string) =>
    request<{ ok: boolean }>(`/drives/${id}/pin`, { method: 'POST' }),

  listByUser: (userId: string) =>
    request<{ drives: PledgeDrive[] }>(`/drives/by-user/${userId}`),

  myPledges: () =>
    request<{ pledges: Pledge[] }>('/my/pledges'),
}

// =============================================================================
// Gift Links
// =============================================================================

// =============================================================================
// Subscription Offers
// =============================================================================

export interface SubscriptionOffer {
  id: string
  label: string
  mode: 'code' | 'grant'
  discountPct: number
  durationMonths: number | null
  code: string | null
  recipientId: string | null
  recipientUsername: string | null
  maxRedemptions: number | null
  redemptionCount: number
  expiresAt: string | null
  revoked: boolean
  createdAt: string
}

export interface OfferLookup {
  id: string
  label: string
  discountPct: number
  durationMonths: number | null
  writerId: string
  writerUsername: string
  writerDisplayName: string | null
  standardPricePence: number
  discountedPricePence: number
}

export const subscriptionOffers = {
  create: (data: {
    label: string
    mode: 'code' | 'grant'
    discountPct: number
    durationMonths?: number | null
    maxRedemptions?: number | null
    expiresAt?: string | null
    recipientUsername?: string
  }) =>
    request<{ id: string; code: string | null; url: string | null }>('/subscription-offers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  list: () =>
    request<{ offers: SubscriptionOffer[] }>('/subscription-offers'),

  revoke: (offerId: string) =>
    request<{ ok: boolean }>(`/subscription-offers/${offerId}`, {
      method: 'DELETE',
    }),

  lookup: (code: string) =>
    request<OfferLookup>(`/subscription-offers/redeem/${code}`),
}

export function subscribe(writerId: string, opts?: { period?: string; offerCode?: string }) {
  return request<{ subscriptionId: string; status: string; pricePence: number; currentPeriodEnd?: string; writerName?: string }>(
    `/subscriptions/${writerId}`,
    {
      method: 'POST',
      body: JSON.stringify({ period: opts?.period, offerCode: opts?.offerCode }),
    }
  )
}

// =============================================================================
// Gift Links
// =============================================================================

export interface GiftLink {
  id: string
  token: string
  maxRedemptions: number
  redemptionCount: number
  revoked: boolean
  createdAt: string
}

export const giftLinks = {
  create: (articleId: string, maxRedemptions = 5) =>
    request<{ id: string; token: string; url: string; maxRedemptions: number }>(`/articles/${articleId}/gift-link`, {
      method: 'POST',
      body: JSON.stringify({ maxRedemptions }),
    }),

  list: (articleId: string) =>
    request<{ giftLinks: GiftLink[] }>(`/articles/${articleId}/gift-links`),

  revoke: (articleId: string, linkId: string) =>
    request<{ ok: boolean }>(`/articles/${articleId}/gift-link/${linkId}`, {
      method: 'DELETE',
    }),

  redeem: (articleId: string, token: string) =>
    request<{ ok: boolean; unlocked: boolean }>(`/articles/${articleId}/redeem-gift`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
}

// =============================================================================
// Admin
// =============================================================================

export interface Report {
  id: string
  reporterUsername: string
  reporterDisplayName: string | null
  targetType: 'article' | 'note' | 'comment' | 'account'
  targetId: string
  reason: string
  contentPreview: string | null
  status: 'pending' | 'resolved'
  resolution: string | null
  createdAt: string
  resolvedAt: string | null
}

export const admin = {
  listReports: (status?: string) =>
    request<{ reports: Report[] }>(`/admin/reports${status ? `?status=${status}` : ''}`),

  resolveReport: (reportId: string, action: 'remove' | 'suspend' | 'dismiss') =>
    request<{ ok: boolean }>(`/admin/reports/${reportId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action }),
    }),

  suspendAccount: (accountId: string) =>
    request<{ ok: boolean }>(`/admin/suspend/${accountId}`, { method: 'POST' }),
}

// =============================================================================
// Account & Settings
// =============================================================================

export interface TabOverview {
  balancePence: number
  freeAllowanceRemainingPence: number
  freeAllowanceTotalPence: number
  recentReads: { articleTitle: string; costPence: number; readAt: string }[]
}

export interface MySubscription {
  id: string
  writerId: string
  writerUsername: string
  writerDisplayName: string | null
  writerAvatar: string | null
  pricePence: number
  status: string
  autoRenew: boolean
  currentPeriodEnd: string
  startedAt: string
  cancelledAt: string | null
  hidden: boolean
  notifyOnPublish: boolean
}

export const account = {
  getTab: () =>
    request<TabOverview>('/my/tab'),

  getMySubscriptions: () =>
    request<{ subscriptions: MySubscription[] }>('/subscriptions/mine'),

  toggleSubscriptionNotifications: (subscriptionId: string, notifyOnPublish: boolean) =>
    request<{ ok: boolean; notifyOnPublish: boolean }>(`/subscriptions/${subscriptionId}/notifications`, {
      method: 'PATCH',
      body: JSON.stringify({ notifyOnPublish }),
    }),

  exportReceipts: () =>
    request<Blob>('/receipts/export'),

  exportAccount: () =>
    request<Blob>('/account/export'),

  updateSubscriptionPrice: (pricePence: number, annualDiscountPct?: number, defaultArticlePricePence?: number | null) =>
    request<{ ok: boolean }>('/settings/subscription-price', {
      method: 'PATCH',
      body: JSON.stringify({
        pricePence,
        ...(annualDiscountPct !== undefined ? { annualDiscountPct } : {}),
        ...(defaultArticlePricePence !== undefined ? { defaultArticlePricePence } : {}),
      }),
    }),

  toggleSubscriptionVisibility: (writerId: string, hidden: boolean) =>
    request<{ ok: boolean; hidden: boolean }>(`/subscriptions/${writerId}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden }),
    }),
}

// =============================================================================
// Publications
// =============================================================================

export interface Publication {
  id: string
  slug: string
  name: string
  tagline: string | null
  about: string | null
  logoBlossomlUrl: string | null
  coverBlossomUrl: string | null
  nostrPubkey: string
  subscriptionPricePence: number
  annualDiscountPct: number
  defaultArticlePricePence: number
  themeConfig: Record<string, any>
  status: string
  foundedAt: string
}

export interface PublicationMembership {
  id: string
  slug: string
  name: string
  logo_blossom_url: string | null
  role: string
  is_owner: boolean
  can_publish: boolean
  can_edit_others: boolean
  can_manage_members: boolean
  can_manage_finances: boolean
  can_manage_settings: boolean
}

export interface PublicationMember {
  id: string
  account_id: string
  role: string
  contributor_type: string
  title: string | null
  is_owner: boolean
  revenue_share_bps: number | null
  can_publish: boolean
  can_edit_others: boolean
  can_manage_members: boolean
  can_manage_finances: boolean
  can_manage_settings: boolean
  username: string
  display_name: string | null
  avatar_blossom_url: string | null
  nostr_pubkey: string
}

export interface PublicationInvite {
  id: string
  role: string
  contributor_type: string
  message: string | null
  expires_at: string
  publication_name: string
  publication_slug: string
  publication_logo: string | null
  inviter_name: string
}

export const publications = {
  // Management
  create: (data: { slug: string; name: string; tagline?: string; about?: string }) =>
    request<{ id: string; slug: string }>('/publications', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (slug: string) =>
    request<Publication>(`/publications/${slug}`),

  update: (id: string, data: Partial<{
    name: string; tagline: string | null; about: string | null;
    logo_blossom_url: string | null; cover_blossom_url: string | null;
    subscription_price_pence: number; annual_discount_pct: number;
    default_article_price_pence: number;
  }>) =>
    request<{ ok: boolean }>(`/publications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  archive: (id: string) =>
    request<{ ok: boolean }>(`/publications/${id}`, { method: 'DELETE' }),

  // Members
  getMembers: (id: string) =>
    request<{ members: PublicationMember[] }>(`/publications/${id}/members`),

  invite: (id: string, data: {
    email?: string; accountId?: string; role?: string;
    contributorType?: string; message?: string;
  }) =>
    request<{ inviteId: string; token: string }>(`/publications/${id}/members/invite`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  acceptInvite: (publicationId: string, token: string) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/members/accept`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  updateMember: (publicationId: string, memberId: string, data: Partial<{
    role: string; contributorType: string; title: string | null;
    revenueShareBps: number | null; canPublish: boolean; canEditOthers: boolean;
    canManageMembers: boolean; canManageFinances: boolean; canManageSettings: boolean;
  }>) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  removeMember: (publicationId: string, memberId: string) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/members/${memberId}`, {
      method: 'DELETE',
    }),

  transferOwnership: (publicationId: string, newOwnerId: string) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/transfer-ownership`, {
      method: 'POST',
      body: JSON.stringify({ newOwnerId }),
    }),

  // CMS
  listArticles: (id: string, opts?: { status?: string; limit?: number; offset?: number }) =>
    request<{ articles: any[] }>(`/publications/${id}/articles${opts?.status ? `?status=${opts.status}` : ''}`),

  submitArticle: (id: string, data: {
    title: string; summary?: string; content: string; fullContent: string;
    accessMode?: string; pricePence?: number; gatePositionPct?: number;
    showOnWriterProfile: boolean; existingDTag?: string;
  }) =>
    request<{ articleId: string; status: string; dTag: string; nostrEventId?: string }>(
      `/publications/${id}/articles`,
      { method: 'POST', body: JSON.stringify(data) }
    ),

  publishArticle: (publicationId: string, articleId: string) =>
    request<{ nostrEventId: string }>(`/publications/${publicationId}/articles/${articleId}/publish`, {
      method: 'POST',
    }),

  unpublishArticle: (publicationId: string, articleId: string) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/articles/${articleId}/unpublish`, {
      method: 'POST',
    }),

  // Reader-facing
  getPublic: (slug: string) =>
    request<{
      id: string; slug: string; name: string; tagline: string | null; about: string | null;
      logo_blossom_url: string | null; cover_blossom_url: string | null;
      nostr_pubkey: string; subscription_price_pence: number; annual_discount_pct: number;
      homepage_layout: string; theme_config: Record<string, any>;
      founded_at: string; follower_count: number; member_count: number; article_count: number;
      isFollowing: boolean; isSubscribed: boolean;
    }>(`/publications/${slug}/public`),

  getPublicArticles: (slug: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.offset) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return request<{ articles: any[] }>(`/publications/by-slug/${slug}/articles${qs ? `?${qs}` : ''}`)
  },

  getMasthead: (slug: string) =>
    request<{ members: any[] }>(`/publications/${slug}/masthead`),

  follow: (id: string) =>
    request<{ ok: boolean }>(`/follows/publication/${id}`, { method: 'POST', body: JSON.stringify({}) }),

  unfollow: (id: string) =>
    request<{ ok: boolean }>(`/follows/publication/${id}`, { method: 'DELETE' }),

  subscribe: (id: string) =>
    request<{ subscriptionId: string }>(`/subscriptions/publication/${id}`, { method: 'POST', body: JSON.stringify({}) }),

  cancelSubscription: (id: string) =>
    request<{ ok: boolean }>(`/subscriptions/publication/${id}`, { method: 'DELETE' }),

  // Revenue (Phase 5)
  getRateCard: (id: string) =>
    request<{ subscriptionPricePence: number; annualDiscountPct: number; defaultArticlePricePence: number; articlePriceMode: string }>(
      `/publications/${id}/rate-card`
    ),

  updateRateCard: (id: string, data: {
    subscriptionPricePence?: number; annualDiscountPct?: number; defaultArticlePricePence?: number; articlePriceMode?: string;
  }) =>
    request<{ ok: boolean }>(`/publications/${id}/rate-card`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  getPayroll: (id: string) =>
    request<{
      members: Array<{
        memberId: string; accountId: string; username: string; displayName: string;
        avatarBlossomUrl: string | null; role: string; contributorType: string;
        title: string | null; isOwner: boolean; revenueShareBps: number | null;
      }>;
      articleShares: Array<{
        id: string; articleId: string; accountId: string; username: string; displayName: string;
        articleTitle: string; articleSlug: string; shareType: string; shareValue: number; paidOut: boolean;
      }>;
      totalStandingBps: number;
    }>(`/publications/${id}/payroll`),

  updatePayroll: (id: string, shares: Array<{ memberId: string; revenueShareBps: number }>) =>
    request<{ ok: boolean; totalBps: number }>(`/publications/${id}/payroll`, {
      method: 'PATCH',
      body: JSON.stringify({ shares }),
    }),

  setArticleShare: (id: string, articleId: string, data: {
    accountId: string; shareType: 'revenue_bps' | 'flat_fee_pence'; shareValue: number;
  }) =>
    request<{ ok: boolean }>(`/publications/${id}/payroll/article/${articleId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  getEarnings: (id: string) =>
    request<{
      summary: {
        grossPence: number; netPence: number; pendingPence: number; paidPence: number; readCount: number;
      };
      articles: Array<{
        articleId: string; title: string; slug: string; publishedAt: string | null;
        readCount: number; netPence: number;
      }>;
      payouts: Array<{
        id: string; totalPoolPence: number; platformFeePence: number; flatFeesPaidPence: number;
        remainingPoolPence: number; status: string; triggeredAt: string; completedAt: string | null;
        splits: Array<{
          accountId: string; username: string; displayName: string; amountPence: number;
          shareType: string; shareBps: number | null; status: string;
        }>;
      }>;
    }>(`/publications/${id}/earnings`),

  // Invites
  getInvite: (token: string) =>
    request<PublicationInvite>(`/publications/invites/${token}`),

  // Personal
  myMemberships: () =>
    request<{ publications: PublicationMembership[] }>('/my/publications'),
}
