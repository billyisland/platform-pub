import { request } from './client'

// =============================================================================
// Writer earnings (payment-side of revenue)
// =============================================================================

export interface WriterEarnings {
  writerId: string
  earningsTotalPence: number
  pendingTransferPence: number
  paidOutPence: number
  // Earnings reserved for in-flight tributes (held|released), shown as
  // "reserved, pending redirect". 0 when the tribute money flow is dark.
  reservedPence: number
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

/**
 * `GET /my/tab` (gateway/src/routes/my-account.ts).
 *
 * The field names here are the ones the route actually sends. Three of the four
 * it previously declared did not exist on the wire — `balancePence`,
 * `freeAllowanceTotalPence` and `recentReads` were all silently `undefined`,
 * and because the API client is a raw pass-through with no key remapping,
 * nothing anywhere reported it. The live consequence was on the Ledger's net
 * balance, which reads `earnings − tabBalance`: with `tabBalance` permanently 0,
 * a reader who owed money saw a net balance as though they owed none.
 *
 * `tabBalancePence` is the LEDGER balance (`ledger_reader_balance`), not
 * `reading_tabs.balance_pence` — see the route's own note on why display reads
 * the ledger while settlement locks the column.
 */
export interface TabOverview {
  tabBalancePence: number
  freeAllowanceRemainingPence: number
  lastSettledAt: string | null
  /**
   * Set when an off-session settlement charge terminally declined. The tab is
   * frozen — settlement backs off and stops retrying — until the reader
   * re-attaches a working card, so this is not a passive warning: nothing moves
   * again until it is cleared. Rendered by `CardActionRequired`.
   */
  cardActionRequiredAt: string | null
  reads: {
    readId: string
    articleTitle: string
    articleDTag: string
    writerDisplayName: string | null
    writerUsername: string | null
    chargePence: number
    readAt: string
    settledAt: string | null
    isSubscriptionRead: boolean
  }[]
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
