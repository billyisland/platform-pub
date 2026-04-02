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
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
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
  wordCount: number | null
  isPaywalled: boolean
  pricePence: number | null
  gatePositionPct: number | null
  vaultEventId: string | null
  publishedAt: string | null
  writer: {
    id: string
    username: string
    displayName: string | null
    avatar: string | null
    pubkey: string
  }
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
    isPaywalled: boolean
    pricePence: number
    gatePositionPct: number
    vaultEventId?: string
  }) =>
    request<{ articleId: string }>('/articles', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
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
  articleCount: number
}

export const writers = {
  getProfile: (username: string) =>
    request<WriterProfile>(`/writers/${username}`),

  getArticles: (username: string, limit = 20, offset = 0) =>
    request<{ articles: any[]; limit: number; offset: number }>(
      `/writers/${username}/articles?limit=${limit}&offset=${offset}`
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
  | 'free_pass_granted'
  | 'dm_payment_required'
  | 'new_user'

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
  list: () =>
    request<{ notifications: Notification[]; unreadCount: number }>('/notifications'),

  markRead: (id: string) =>
    request<{ ok: boolean }>(`/notifications/${id}/read`, { method: 'POST' }),

  readAll: () =>
    request<{ ok: boolean }>('/notifications/read-all', { method: 'POST' }),
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

export interface DirectMessage {
  id: string
  conversationId: string
  senderId: string
  senderUsername: string
  senderDisplayName: string | null
  senderAvatar: string | null
  content: string
  createdAt: string
}

export const messages = {
  listConversations: () =>
    request<{ conversations: Conversation[] }>('/messages'),

  getMessages: (conversationId: string, cursor?: string) =>
    request<{ messages: DirectMessage[]; nextCursor: string | null }>(
      `/messages/${conversationId}${cursor ? `?cursor=${cursor}` : ''}`
    ),

  send: (conversationId: string, content: string) =>
    request<{ messageId: string }>(`/messages/${conversationId}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  markRead: (messageId: string) =>
    request<void>(`/messages/${messageId}/read`, { method: 'POST' }),

  createConversation: (memberIds: string[]) =>
    request<{ conversationId: string }>('/conversations', {
      method: 'POST',
      body: JSON.stringify({ memberIds }),
    }),
}

// =============================================================================
// Pledge Drives
// =============================================================================

export interface PledgeDrive {
  id: string
  writerId: string
  writerUsername: string
  type: 'crowdfund' | 'commission'
  title: string
  description: string
  targetAmountPence: number
  currentAmountPence: number
  pledgeCount: number
  status: 'active' | 'funded' | 'cancelled' | 'completed'
  pinnedOnProfile: boolean
  createdAt: string
  fundedAt: string | null
}

export interface Pledge {
  id: string
  driveId: string
  driveTitle: string
  writerUsername: string
  amountPence: number
  status: string
  createdAt: string
}

export interface FreePass {
  userId: string
  username: string
  displayName: string | null
  grantedAt: string
}

export const drives = {
  create: (data: { type: 'crowdfund' | 'commission'; title: string; description: string; targetAmountPence: number; targetWriterId?: string }) =>
    request<{ driveId: string }>('/drives', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (id: string) =>
    request<PledgeDrive>(`/drives/${id}`),

  update: (id: string, data: { title?: string; description?: string; targetAmountPence?: number }) =>
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

  accept: (id: string) =>
    request<{ ok: boolean }>(`/drives/${id}/accept`, { method: 'POST' }),

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
// Free Passes
// =============================================================================

export const freePasses = {
  list: (articleId: string) =>
    request<{ passes: FreePass[] }>(`/articles/${articleId}/free-passes`),

  grant: (articleId: string, username: string) =>
    request<{ ok: boolean }>(`/articles/${articleId}/free-pass`, {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),

  revoke: (articleId: string, userId: string) =>
    request<{ ok: boolean }>(`/articles/${articleId}/free-pass/${userId}`, {
      method: 'DELETE',
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
  writerUsername: string
  writerDisplayName: string | null
  writerAvatar: string | null
  pricePence: number
  status: string
  startedAt: string
}

export const account = {
  getTab: () =>
    request<TabOverview>('/my/tab'),

  getMySubscriptions: () =>
    request<{ subscriptions: MySubscription[] }>('/subscriptions/mine'),

  exportReceipts: () =>
    request<Blob>('/receipts/export'),

  exportAccount: () =>
    request<Blob>('/account/export'),

  updateSubscriptionPrice: (pricePence: number) =>
    request<{ ok: boolean }>('/settings/subscription-price', {
      method: 'PATCH',
      body: JSON.stringify({ pricePence }),
    }),
}
