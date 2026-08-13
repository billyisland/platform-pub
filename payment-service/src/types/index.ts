// =============================================================================
// all.haus — Payment Service Types
// Derived from ADR v0.7 and schema.sql
// =============================================================================

export type ReadState = 'provisional' | 'accrued' | 'platform_settled' | 'writer_paid'

// -----------------------------------------------------------------------------
// Config
//
// `PlatformConfig` lives in shared/src/types/config.ts and is NOT redeclared
// here. It was, until 2026-08-13, and the two copies rotted: shared's grew
// `payoutHaltEscalationHours` and this one did not, because the parity suites
// pin config VALUES and nothing pins the type. Every consumer here already
// takes its config from `loadConfig()` in @platform-pub/shared/db/client.js,
// which returns shared's shape — so the local copy was never the thing being
// loaded, only a second description of it that could disagree in silence.
//
// Import the type from '@platform-pub/shared/types/config.js'.
// -----------------------------------------------------------------------------

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
  publicationId?: string | null  // F2: denormalised onto read_events so the writer payout cycle can exclude publication reads
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
  // tributes in flight. Dial A: 'released' is the only reserved state — money
  // frozen for a CONSENTED, onboarding inspirer, awaiting the inspirer payout,
  // NOT yet redirected. Shown on the dashboard as "reserved, pending redirect"
  // (compliance condition #4). Excludes 'paid' (already transferred). 0 dark.
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
