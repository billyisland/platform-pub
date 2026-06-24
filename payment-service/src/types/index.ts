// =============================================================================
// all.haus — Payment Service Types
// Derived from ADR v0.7 and schema.sql
// =============================================================================

export type ReadState = 'provisional' | 'accrued' | 'platform_settled' | 'writer_paid'

// -----------------------------------------------------------------------------
// Config — all monetary values in pence (integers, never floats)
// -----------------------------------------------------------------------------

export interface PlatformConfig {
  freeAllowancePence: number           // default 500  (£5.00)
  tabSettlementThresholdPence: number  // default 800  (£8.00)
  monthlyFallbackMinimumPence: number  // default 200  (£2.00)
  writerPayoutThresholdPence: number   // default 2000 (£20.00)
  platformFeeBps: number               // default 800  (8.00%)
  monthlyFallbackDays: number          // default 30   (days since last read before monthly settlement)
}

// -----------------------------------------------------------------------------
// Gate pass — the event that enters the payment service
//
// FIX #11: Removed onFreeAllowance. The accrual service determines
// free-allowance status from the database (whether the reader has a
// stripe_customer_id), not from the caller's assertion. Including it in
// the API contract was misleading — the field was accepted but ignored.
// -----------------------------------------------------------------------------

export interface GatePassEvent {
  readerId: string        // UUID
  articleId: string       // UUID
  writerId: string        // UUID
  amountPence: number
  readerPubkey: string      // actual Nostr pubkey — used for portable receipt (stored privately)
  readerPubkeyHash: string  // keyed HMAC — used in public kind 9901 relay event
  tabId: string           // UUID of reader's reading_tab
}

// -----------------------------------------------------------------------------
// Read event — persisted record of a gate pass
// -----------------------------------------------------------------------------

export interface ReadEvent {
  id: string
  readerId: string
  articleId: string
  writerId: string
  tabId: string | null
  amountPence: number
  state: ReadState
  receiptNostrEventId: string | null
  readerPubkeyHash: string | null
  tabSettlementId: string | null
  writerPayoutId: string | null
  onFreeAllowance: boolean
  readAt: Date
  stateUpdatedAt: Date
}

// -----------------------------------------------------------------------------
// Reading tab — running balance per reader
// -----------------------------------------------------------------------------

export interface ReadingTab {
  id: string
  readerId: string
  balancePence: number
  lastReadAt: Date | null
  lastSettledAt: Date | null
}

// -----------------------------------------------------------------------------
// Writer earnings view — what the dashboard reads
// (platform_settled + writer_paid reads only — provisional and accrued hidden)
//
// FIX #4: All pence values are now post-platform-fee (net to writer).
// Previously these were gross amounts (what the reader paid), which
// contradicted ADR §I.3: "Writers' dashboards show post-cut earnings."
// -----------------------------------------------------------------------------

export interface WriterEarnings {
  writerId: string
  earningsTotalPence: number       // platform_settled + writer_paid (net of 8% fee AND of tribute carve)
  pendingTransferPence: number     // platform_settled not yet paid out (net of 8% fee AND tribute carve)
  paidOutPence: number             // writer_paid (net of 8% fee AND tribute carve)
  // Upstream Edges Phase 3: the author's earnings carved off and reserved for
  // tributes still in flight (held = pending consent, released = consented,
  // awaiting the inspirer payout) — NOT yet redirected. Shown on the dashboard
  // as "reserved, pending redirect" (compliance condition #4). Excludes 'paid'
  // (already transferred) and 'swept'/'returned' (still the author's). 0 dark.
  reservedPence: number
  readCount: number
}

// -----------------------------------------------------------------------------
// Per-article earnings — breakdown for the dashboard per-article table
// Per ADR §I.2: "settled per-article revenue, with a clear breakdown"
// -----------------------------------------------------------------------------

export interface ArticleEarnings {
  articleId: string
  title: string
  dTag: string
  publishedAt: string | null
  readCount: number
  netEarningsPence: number         // total net (platform_settled + writer_paid)
  pendingPence: number             // platform_settled portion
  paidPence: number                // writer_paid portion
}
