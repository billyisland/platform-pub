import { request } from './client'

// =============================================================================
// Owner dashboard API — gateway /admin/dashboard/* (requireAdmin).
// Types mirror gateway/src/routes/admin-dashboard.ts response shapes.
// =============================================================================

export interface AdminOverview {
  accrual: {
    activeTabCount: number
    totalAccruedPence: number
    totalCreditPence: number
    nearThresholdTabs: number
    settlementThresholdPence: number
    provisionalReadCount: number
    provisionalTotalPence: number
    accruedReadCount: number
    accruedTotalPence: number
  }
  settlement: {
    pendingCount: number
    pendingPence: number
    oldestPendingAt: string | null
    completedCount: number
    completedPence: number
    lastCompletedAt: string | null
    failedCount: number
    chargedBackReadCount: number
    chargedBackPence: number
  }
  payout: {
    writersAwaitingPayout: number
    outstandingEarningsPence: number
    pendingCount: number
    pendingPence: number
    initiatedCount: number
    initiatedPence: number
    completedCount: number
    completedPence: number
    failedCount: number
    failedPence: number
    reversedCount: number
    reversedPence: number
    lastPayoutAt: string | null
    halted: boolean
    haltReason: string | null
    haltedSince: string | null
    /** Per-account freezes (W4) — distinct from the platform-wide `halted`. */
    haltedAccounts: Array<{
      accountId: string
      username: string | null
      displayName: string | null
      mismatchClass: string
      reason: string
      since: string
    }>
  }
  revenue: {
    allTimePlatformFeePence: number
    last30DaysPlatformFeePence: number
    last7DaysPlatformFeePence: number
    todayPlatformFeePence: number
  }
  custody: {
    heldReadCount: number
    totalHeldPence: number
    oldestHeldReadAt: string | null
    holdingDurationDays: number
    holdingWarningDays: number
  }
  counts: {
    totalAccounts: number
    activeAccounts: number
    readersWithCard: number
    publishingWriters: number
    readersEver: number
    openReportCount: number
  }
}

export interface AdminUsers {
  totals: {
    accounts: number
    active: number
    suspended: number
    moderated: number
    deactivated: number
    readersWithCard: number
    readersOnFreeAllowance: number
    readersAllowanceExhausted: number
    cardActionRequired: number
  }
  growth: {
    signupsLast7d: number
    signupsLast30d: number
  }
  kycIncomplete: {
    count: number
    writers: Array<{
      id: string
      username: string
      displayName: string | null
      connectStarted: boolean
      pendingEarningsPence: number
    }>
  }
  conversionFunnel: {
    totalReadersEver: number
    exhaustedAllowance: number
    connectedCard: number
    conversionRate: number | null
  }
}

export interface AdminContent {
  articles: {
    totalPublished: number
    publishedLast7d: number
    publishedLast30d: number
    paywalledCount: number
    freeCount: number
    avgPricePence: number | null
  }
  notes: { total: number; last7d: number; last30d: number }
  engagement: {
    totalReadEvents: number
    readEventsLast7d: number
    totalComments: number
    commentsLast7d: number
    totalVotes: number
    votesLast7d: number
  }
  drives: {
    openCount: number
    fundedCount: number
    publishedCount: number
    fulfilledCount: number
    activePledgedPence: number
  }
  health: {
    feedScoresRefreshedAt: string | null
    feedScoresStalenessMinutes: number | null
    jetstreamHealthy: boolean | null
    relayOutboxPending: number
    relayOutboxOldestPendingAt: string | null
    relayOutboxFailed: number
  }
}

export interface AdminConfigRow {
  key: string
  value: string
  description: string | null
  updatedAt: string
  readOnly: boolean
}

export interface AdminRegulatory {
  rolling12MonthRevenuePence: number
  currentMonthRevenuePence: number
  annualisedRunRatePence: number
  thresholds: {
    tradingAllowance: {
      thresholdPence: number
      currentPence: number
      percentUsed: number
      status: 'within' | 'exceeded'
    }
    vatRegistration: {
      thresholdPence: number
      warningPct: number
      currentPence: number
      percentUsed: number
      status: 'clear' | 'approaching' | 'exceeded'
    }
    corporationTax: {
      smallProfitsThresholdPence: number
      mainRateThresholdPence: number
      currentRevenuePence: number
      status: 'below_small_profits' | 'marginal_relief' | 'main_rate'
    }
  }
  custody: {
    totalHeldPence: number
    oldestHeldDays: number
    warningThresholdDays: number
    status: 'normal' | 'warning'
  }
  financialYear: { start: string; end: string; daysRemaining: number }
}

export interface AdminWaitlist {
  totals: {
    total: number
    joinedLast7d: number
    /** Rows with an account behind them. */
    admitted: number
    /** Admitted but the invitation never went — the state that wants a retry. */
    admittedNotInvited: number
  }
  /** When the operator digest last went out; null = never (CLOSED-BETA-ADR §XI.4). */
  lastDigestAt: string | null
  /** True when the list exceeded the route's cap — never a silent truncation. */
  truncated: boolean
  shown: number
  entries: Array<{
    email: string
    joinedAt: string
    /** An account exists for this address (migration 163). */
    admittedAt: string | null
    /** The invitation email went. Separate: the two can fail apart. */
    invitedAt: string | null
    /** Who they became; null if unadmitted, or if that account was deleted. */
    username: string | null
  }>
}

/** The outcome of one Admit click — what the operator needs told back. */
export interface AdminWaitlistAdmitResult {
  email: string
  admitted: true
  /** False when they already had an account and were linked, not created. */
  accountCreated: boolean
  username: string | null
  /** False = admitted, but the invitation didn't send. Retry with the same call. */
  invited: boolean
}

export const adminDashboard = {
  overview: () => request<AdminOverview>('/admin/dashboard/overview'),
  users: () => request<AdminUsers>('/admin/dashboard/users'),
  content: () => request<AdminContent>('/admin/dashboard/content'),
  config: () => request<{ config: AdminConfigRow[] }>('/admin/dashboard/config'),
  updateConfig: (updates: Array<{ key: string; value: string }>) =>
    request<{ ok: boolean; updated: number }>('/admin/dashboard/config', {
      method: 'PATCH',
      body: JSON.stringify({ updates }),
    }),
  regulatory: () => request<AdminRegulatory>('/admin/dashboard/regulatory'),
  waitlist: () => request<AdminWaitlist>('/admin/dashboard/waitlist'),
  admitWaitlister: (email: string) =>
    request<AdminWaitlistAdmitResult>('/admin/dashboard/waitlist/admit', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  triggerSettlements: () =>
    request<{ settlementTriggered: number }>('/admin/dashboard/trigger-settlements', {
      method: 'POST',
    }),
  triggerPayouts: () =>
    request<{ processed: number; totalPaidPence: number }>('/admin/dashboard/trigger-payouts', {
      method: 'POST',
    }),
}
