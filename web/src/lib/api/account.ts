import { request } from './client'

// =============================================================================
// Writer earnings (payment-side of revenue)
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

export const payment = {
  getEarnings: (writerId: string) =>
    request<WriterEarnings>(`/earnings/${writerId}`),

  getPerArticleEarnings: (writerId: string) =>
    request<{ articles: ArticleEarnings[] }>(`/earnings/${writerId}/articles`),
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

export interface Subscriber {
  subscriptionId: string
  readerId: string
  readerUsername: string
  readerDisplayName: string | null
  readerAvatar: string | null
  pricePence: number
  status: string
  isComp: boolean
  autoRenew: boolean
  subscriptionPeriod: string
  startedAt: string
  currentPeriodEnd: string
  cancelledAt: string | null
  articlesRead: number
  totalArticleValuePence: number
  gettingMoneysworth: boolean
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

  getSubscribers: () =>
    request<{ subscribers: Subscriber[] }>('/subscribers'),
}
