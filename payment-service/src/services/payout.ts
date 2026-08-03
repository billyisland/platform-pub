import Stripe from 'stripe'
import type { PoolClient } from 'pg'
import type { WriterEarnings, ArticleEarnings } from '../types/index.js'
import { pool, withTransaction, loadConfig } from '@platform-pub/shared/db/client.js'
import { recordLedger } from '@platform-pub/shared/lib/ledger.js'
import { tributesEnabled, allocatedFundsEnabled } from '@platform-pub/shared/lib/env.js'
import { readNetSql, perReadNetPence } from '@platform-pub/shared/lib/per-read-net.js'
import { isConnectPayable } from '../lib/connect-payable.js'
import { isPayoutsHalted } from '../lib/payout-halt.js'
import { isTerminalTransferError } from '../lib/charge-errors.js'
import {
  executeStripeIdempotent,
  stripeErrorCode,
  type StripeIdempotentOutcome,
} from '../lib/stripe-idempotent.js'
import { createAllocationAwareStripe } from '../lib/stripe-client.js'
import {
  packUnits,
  apportionCarve,
  prorateWithheldFee,
  prorateCarveReversal,
  type EarningUnit,
  type FundingSource,
} from '../lib/allocation-packer.js'
import {
  lockFundingSources,
  insertChildren,
  hasChildren,
  executePendingChildren,
  completeParentIfSettled,
  findChildByTransferId,
  reverseChild,
  failChild,
  type ChildCycleSpec,
  type ChildRow,
} from './payout-children.js'
import logger from '../lib/logger.js'

// =============================================================================
// PayoutService — Stage 3 of the three-stage money flow
//
// Runs on a daily rolling basis. For each writer whose available balance
// (platform_settled reads not yet paid out) exceeds £20.00:
//   1. Lock writer record
//   2. Compute amount = sum of platform_settled read_events not yet in a payout
//   3. Create Stripe Connect transfer from platform account to writer
//   4. Write writer_payout record
//   5. Link read_events to payout
//
// Writer must have completed Stripe Connect KYC before payouts can be made.
// Earnings accrue and are held until verification completes.
// =============================================================================

// =============================================================================
// Publication split computation — extracted as a pure function for testability
// =============================================================================

export interface ArticleShare {
  id: string
  articleId: string
  accountId: string
  shareType: 'flat_fee_pence' | 'revenue_bps'
  shareValue: number
  paidOut: boolean
}

export interface StandingMember {
  accountId: string
  revenueShareBps: number
}

interface Split {
  accountId: string
  amountPence: number
  shareType: string
  shareBps: number | null
  articleId: string | null
}

interface SplitResult {
  platformFeePence: number
  splits: Split[]
  remainingPool: number
  flatFeesPaidPence: number
  flatFeeShareIds: string[]
}

/**
 * Complete a publication payout when NO SPLIT IS LEFT 'pending' — the one home
 * for that rule, used by `finalisePublicationPayout` and
 * `completePublicationParentBySplit`. (A third caller, `confirmPublicationSplit`,
 * was deleted with the transfer.paid branch — audit F4, 2026-07-30.)
 *
 * THE ZOMBIE THIS FIXES. The predicate was `NOT EXISTS (split WHERE status <>
 * 'completed')` while the resume sweep retries only 'pending' splits. So a
 * single terminally-'failed' split left the parent 'pending' FOREVER: every
 * cycle the sweep picked it up, found nothing to retry, finalised, failed the
 * same test, and left the row exactly as it was. Nothing in the system could
 * resolve it. (Audit F4 introduced that predicate to stop a still-in-flight
 * split being masked as a finished payout, which is right — but 'failed' is not
 * in flight, it is *done*, and it is already visible on the split's own row.)
 *
 * A failed split does not mean the payout failed: the pool was claimed, the
 * reads consumed, and the other members paid. It means one recipient needs a
 * manual re-pay (§1.2). A split still 'pending' — recipient KYC-incomplete —
 * DOES hold the parent open, so the sweep retries it next cycle; that arm is
 * unchanged.
 *
 * Exported so the integration test executes THIS statement rather than a copy
 * of it, which is what stops the test and production drifting apart.
 */
/**
 * The publication pool's claim over its reads — exported so the DB-backed test
 * executes THIS TEXT rather than a copy of it.
 *
 * THE COLUMN IS `publication_payout_id`, and getting it wrong is what made this
 * entire cycle a silent no-op from the day it was written until migration 168.
 * `$1` is a `publication_payouts` id; `writer_payout_id`'s FK points at
 * `writer_payouts`, so the old form raised `23503` on every claim and rolled the
 * whole reserve transaction back. `runPublicationPayoutCycle` catches
 * per-publication errors and logs, so the only symptom was that publications were
 * never paid — no alert, no failure, nothing to notice.
 *
 * It survived because NOTHING in the repo drove this cycle against a real
 * database: the unit tests exercise `computePublicationSplits` (pure) and the
 * ordering constants (SQL, but SELECTs), and neither can see a constraint. The
 * paired control in the DB test runs the pre-fix statement and asserts it still
 * raises 23503 — the fix is only meaningful if the bug it fixes is real.
 *
 * `tab_settlement_id` rides along for §3.4: a split's net is a bps share of a
 * pool spanning many charges, so it has no single natural funding charge — the
 * pool's contributing settlements become the packer's PREFERENCE SET instead.
 */
export const PUBLICATION_CLAIM_READS_SQL = `
  UPDATE read_events
     SET publication_payout_id = $1
   WHERE read_events.publication_id = $2
     AND read_events.state = 'platform_settled'
     AND read_events.publication_payout_id IS NULL
  RETURNING chargeable_pence, tab_settlement_id`

/**
 * Advance the reads a completed publication payout has now paid for.
 *
 * Keyed on `publication_payout_id` for the same reason as the claim, and
 * additionally state-filtered: a read the chargeback planner flipped to
 * `charged_back` mid-flight has already been ledger-reversed as if paid, and must
 * keep its terminal state.
 */
export const PUBLICATION_FINALISE_READS_SQL = `
  UPDATE read_events
     SET state = 'writer_paid', state_updated_at = now()
   WHERE read_events.publication_id = $1
     AND read_events.publication_payout_id = $2
     AND read_events.state = 'platform_settled'`

export const PUBLICATION_PAYOUT_COMPLETE_SQL = `
  UPDATE publication_payouts pp
     SET status = 'completed', completed_at = now()
   WHERE pp.id = $1
     AND pp.status = 'pending'
     AND NOT EXISTS (
       SELECT 1 FROM publication_payout_splits s
        WHERE s.publication_payout_id = pp.id
          AND s.status = 'pending')`

/**
 * What is still standing of a parent, tallied when one of its children is
 * reversed — the one home for the parent-flips-to-'reversed' rule, shared by
 * all three cycles (writer / tribute / publication split; $2 is the
 * parent_table).
 *
 * PENDING counts as standing (§0o.3, 2026-08-03). A pending child is money
 * that has not moved YET, not money that never will: child A completes, the
 * process crashes before child B executes, A is manually reversed before the
 * next cycle — tallied over completed+reversed alone, outstanding reads 0 and
 * the parent flips `pending → 'reversed'`, at which point the resume sweeps
 * (which scan `status = 'pending'` parents only) never see it again and B's
 * claimed units are frozen forever. Counting B's untouched net keeps the
 * parent un-flipped until B resolves. FAILED stays excluded, in both
 * directions deliberately: nothing moved and — since `failChild` released its
 * units — nothing will, so a failed child must neither hold the flip open nor
 * count toward what was reversed.
 */
export const REVERSAL_OUTSTANDING_SQL = `
  SELECT COALESCE(SUM(net_pence - reversed_pence), 0) AS outstanding
    FROM payout_transfers
   WHERE parent_table = $2 AND parent_id = $1
     AND status IN ('pending', 'completed', 'reversed')`

// -----------------------------------------------------------------------------
// The split re-pay sweep's SQL (§1.2, migration 167).
//
// Exported for the reason the statements above and below are: the integration
// test executes THESE statements rather than copies of them. Every one is a
// predicate a mocked `pool.query` would have to restate, and restating is how a
// test comes to pin its own fixture instead of the code — the sweep itself
// drives the module-level `pool` and so is unreachable from a rolled-back
// transaction, exactly like `executePendingChildren`.
// -----------------------------------------------------------------------------

/**
 * Splits eligible for a re-pay attempt. `replaced_by_split_id IS NULL` is what
 * makes the sweep idempotent — a replacement minted on an earlier run takes its
 * predecessor out of this set permanently, so a crash mid-sweep cannot mint two.
 */
export const PUB_SPLIT_REPAY_CANDIDATES_SQL = `
  SELECT s.id, s.publication_payout_id, s.account_id, s.share_bps,
         s.amount_pence, s.share_type, s.article_id, s.attempt,
         pp.publication_id
    FROM publication_payout_splits s
    JOIN publication_payouts pp ON pp.id = s.publication_payout_id
   WHERE s.status = 'failed'
     AND s.replaced_by_split_id IS NULL
     AND s.amount_pence > 0
   ORDER BY s.created_at ASC`

/**
 * The replacement row. Attribution is COPIED, never recomputed: amount, bps,
 * share_type and article_id come straight off the predecessor, because
 * computePublicationSplits already decided them and a re-pay must not silently
 * redistribute a pool.
 */
export const PUB_SPLIT_MINT_REPLACEMENT_SQL = `
  INSERT INTO publication_payout_splits
    (publication_payout_id, account_id, share_bps, amount_pence,
     share_type, article_id, status, attempt)
  VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
  RETURNING id`

export const PUB_SPLIT_SUPERSEDE_SQL = `
  UPDATE publication_payout_splits
     SET replaced_by_split_id = $2
   WHERE id = $1`

/**
 * A fresh pending split on a COMPLETED parent must reopen it, or
 * resumePendingPublicationPayouts — which scans 'pending' parents only — never
 * processes the row. PUBLICATION_PAYOUT_COMPLETE_SQL re-completes it once no
 * split is pending, so this is a loop back into the normal lifecycle rather than
 * a special case bolted beside it.
 */
export const PUB_SPLIT_REOPEN_PARENT_SQL = `
  UPDATE publication_payouts
     SET status = 'pending', completed_at = NULL
   WHERE id = $1 AND status = 'completed'`

/**
 * The fee-proration denominator: what this payout is actually DISTRIBUTING.
 * Excluding superseded rows is load-bearing — counted, the denominator would
 * grow with every re-pay and quietly shrink each replacement's application fee
 * below the one its predecessor carried.
 */
export const PUB_SPLIT_DISTRIBUTED_SQL = `
  SELECT COALESCE(SUM(amount_pence), 0) AS total
    FROM publication_payout_splits
   WHERE publication_payout_id = $1
     AND replaced_by_split_id IS NULL`

// -----------------------------------------------------------------------------
// The tribute cycle's per-child SQL (§3.4).
//
// Exported for the same reason as the statement above: the integration test
// executes THESE statements rather than copies of them, so a predicate that
// changes in production changes in the test too. Every one of them is a
// predicate a mocked `pool.query` would have to restate — and restating is how
// a test comes to pin its own fixture instead of the code.
// -----------------------------------------------------------------------------

/**
 * The carve THIS child's accruals debit from the author — their GROSS, not the
 * child's net (the onward carve flows from the inspirer, not the author).
 *
 * `state = 'released'` is deliberate and ORDER-DEPENDENT: `postLedger` runs
 * before `advanceUnits` inside the shared completion transaction, so the rows
 * are still released when this is read. Read after the advance it would sum 0
 * and the author would keep earnings that left them — which is exactly the
 * mutation this statement's test runs.
 */
export const TRIBUTE_CHILD_CARVE_SQL = `
  SELECT COALESCE(SUM(amount_pence), 0) AS carve_pence
    FROM tribute_accruals
   WHERE payout_transfer_id = $1 AND state = 'released'`

/** Advance exactly this child's accruals. Its predicate is the carve's pair. */
export const TRIBUTE_CHILD_ADVANCE_SQL = `
  UPDATE tribute_accruals
     SET state = 'paid'
   WHERE payout_transfer_id = $1
     AND state = 'released'`

/**
 * A claimed accrual whose READ was charged back mid-flight is terminal, not
 * re-claimable: the chargeback planner already reversed it as-if-paid, so
 * releasing it would let the next cycle re-pay clawed-back money.
 */
export const TRIBUTE_CHILD_VOID_SQL = `
  UPDATE tribute_accruals ta
     SET state = 'voided', tribute_payout_id = NULL, payout_transfer_id = NULL
    FROM read_events re
   WHERE ta.payout_transfer_id = $1
     AND ta.state = 'released'
     AND re.id = ta.read_event_id
     AND re.state = 'charged_back'
  RETURNING ta.amount_pence`

/** Release the rest for re-pay under a fresh child. State-filtered. */
export const TRIBUTE_CHILD_RELEASE_SQL = `
  UPDATE tribute_accruals
     SET state = 'released', tribute_payout_id = NULL, payout_transfer_id = NULL
   WHERE payout_transfer_id = $1
     AND state = 'released'`

/**
 * The accruals the onward carve consumed entirely: claimed, no child, nothing
 * transferred for them. RETURNING is the single-shot gate the root carve entry
 * needs — a second call matches no rows and posts nothing.
 */
export const TRIBUTE_CHILDLESS_ADVANCE_SQL = `
  UPDATE tribute_accruals
     SET state = 'paid'
   WHERE tribute_payout_id = $1
     AND payout_transfer_id IS NULL
     AND state = 'released'
  RETURNING amount_pence`

export function computePublicationSplits(
  grossPence: number,
  feeBps: number,
  articleShares: ArticleShare[],
  articleEarnings: Map<string, number>,
  standingMembers: StandingMember[],
  subNetPence: number = 0,
): SplitResult {
  // Sum-then-floor on the GROSS pool — deliberately a DIFFERENT formula from the
  // per-row-then-floor rule in readNetSql/perReadNetPence (shared/lib/per-read-net.ts).
  // A publication distributes one pooled fee across the whole pool, not a fee per
  // read, so do NOT "consolidate" this into readNetSql — it would change the rounding.
  //
  // subNetPence (§1.3): publication SUBSCRIPTION earnings joining this pool.
  // Already NET — logSubscriptionCharge floors the platform fee per charge —
  // so it is added to the pool AFTER the pooled fee, never run through it
  // (the same already-net rule as the writer cycle's `sub` CTE). Sub income is
  // not tied to an article, so it never feeds article-override earnings; it
  // enlarges the pool that flat fees draw from and standing members split.
  const platformFeePence = Math.floor(grossPence * feeBps / 10000)
  let remainingPool = grossPence - platformFeePence + subNetPence
  let flatFeesPaidPence = 0
  const splits: Split[] = []
  const flatFeeShareIds: string[] = []

  // Step 1: Per-article overrides
  // F10: revenue_bps is a FIXED share of the article's revenue. Clamp each
  // article's cumulative bps at 10000 so overlapping overrides can't overdraw its
  // net and drive the pool negative (defensive — the write path also rejects a
  // Σ > 10000 override set). The platform keeps any unallocated bps.
  const articleBpsUsed = new Map<string, number>()
  for (const share of articleShares) {
    if (share.shareType === 'flat_fee_pence' && !share.paidOut) {
      const fee = share.shareValue
      if (fee > remainingPool) continue
      remainingPool -= fee
      flatFeesPaidPence += fee
      flatFeeShareIds.push(share.id)
      splits.push({
        accountId: share.accountId, amountPence: fee,
        shareType: 'flat_fee', shareBps: null,
        articleId: share.articleId,
      })
    } else if (share.shareType === 'revenue_bps') {
      const used = articleBpsUsed.get(share.articleId) ?? 0
      const bps = Math.min(share.shareValue, 10000 - used)
      if (bps <= 0) continue
      articleBpsUsed.set(share.articleId, used + bps)
      const articleNet = articleEarnings.get(share.articleId) || 0
      // Clamp to the remaining pool like the flat-fee branch (M4): the override
      // pays a fraction of the ARTICLE's net, but flat fees already consumed part
      // of the shared pool, so an unclamped combined flat+bps distribution could
      // pay out more than the pool — the platform funding the difference.
      const payout = Math.min(Math.floor(articleNet * bps / 10000), remainingPool)
      if (payout <= 0) continue
      remainingPool -= payout
      splits.push({
        accountId: share.accountId, amountPence: payout,
        shareType: 'article_revenue', shareBps: bps,
        articleId: share.articleId,
      })
    }
  }

  // F10: floor the pool at 0 before standing distribution — overrides (or flat
  // fees) must never drive standing shares or the platform's retained remainder
  // negative.
  if (remainingPool < 0) remainingPool = 0

  // Step 2: Standing shares — FIXED share of revenue (F10), NOT normalized weight.
  // Each member receives bps/10000 of the remaining pool; the platform RETAINS
  // any unallocated remainder (Σ bps < 10000) rather than renormalising it out to
  // the members (the old `× bps / totalStandingBps` paid a sole 1-bps member 100%
  // of the pool). The write paths enforce Σ standing bps ≤ 10000, but they are
  // not airtight (concurrent edits race the read-then-write guard; historical
  // rows predate the cap), so clamp cumulatively here too — the standing twin
  // of articleBpsUsed above. A member whose share is clipped by the clamp is
  // partially paid; the platform keeps the rest (2026-07-06 audit P1: without
  // this, Σ bps > 10000 paid out more than remainingPool at transfer time).
  if (remainingPool > 0) {
    let standingBpsUsed = 0
    for (const member of standingMembers) {
      const bps = Math.min(member.revenueShareBps, 10000 - standingBpsUsed)
      if (bps <= 0) continue
      standingBpsUsed += bps
      const payout = Math.floor(remainingPool * bps / 10000)
      if (payout <= 0) continue
      splits.push({
        accountId: member.accountId, amountPence: payout,
        shareType: 'standing', shareBps: bps,
        articleId: null,
      })
    }
  }

  return { platformFeePence, splits, remainingPool, flatFeesPaidPence, flatFeeShareIds }
}

// =============================================================================
// The reserve path's order-dependent reads — exported for the same reason
// computePublicationSplits is: they are the half of the allocation that lives in
// SQL. computePublicationSplits consumes an ALREADY-ORDERED array and funds it
// first-come-first-served out of a shared pool, so when the pool is short these
// ORDER BYs decide who gets paid — the ordering is allocation logic, not
// presentation. Kept as constants so the DB-backed ordering test executes the
// SAME text the cycle does rather than a copy that can silently drift out of
// step with it (repo idiom: gateway/src/lib/dedup-sql.ts).
// =============================================================================

/**
 * M4: flat fees ('flat_fee_pence' sorts before 'revenue_bps') are honoured
 * before proportional bps overrides, then stable by (article_id, id) for
 * reproducibility across runs.
 */
export const PUBLICATION_ARTICLE_SHARES_SQL = `SELECT pas.id, pas.article_id, pas.account_id, pas.share_type, pas.share_value, pas.paid_out
         FROM publication_article_shares pas
         JOIN articles a ON a.id = pas.article_id
         WHERE pas.publication_id = $1
         ORDER BY pas.share_type, pas.article_id, pas.id`

/**
 * The compute clamp (Σ standing bps capped at 10000) clips whoever comes LAST,
 * so the order must be deterministic — seniority, then id as the tiebreak.
 */
export const PUBLICATION_STANDING_MEMBERS_SQL = `SELECT account_id, revenue_share_bps
         FROM publication_members
         WHERE publication_id = $1 AND removed_at IS NULL AND revenue_share_bps > 0
         ORDER BY created_at ASC, id ASC`

/**
 * Thrown from inside a reserve transaction when the packing overflow leaves a
 * payout under the threshold. It exists to ROLL THE TRANSACTION BACK — the claim
 * must be released, not merely skipped — while telling the caller this is an
 * ordinary outcome, not a failure worth an error log.
 */
class PayoutBelowThresholdError extends Error {}

class PayoutService {
  private stripe: Stripe

  constructor() {
    // Allocation-aware: under STRIPE_ALLOCATED_FUNDS this client speaks the
    // preview API version, because every transfer it creates draws on a charge's
    // segregated balance. Flag off ⇒ 2023-10-16, exactly as before.
    this.stripe = createAllocationAwareStripe()
  }

  // ---------------------------------------------------------------------------
  // getWriterEarnings — for the dashboard endpoint
  //
  // FIX #4: The ADR (§I.3) states: "Writers' dashboards show post-cut
  // earnings throughout." Previously this query summed gross amount_pence
  // from read_events, which is what the reader paid — not what the writer
  // earns. Now we join to tab_settlements to compute the writer's net share.
  //
  // For writer_paid reads, the payout amount already reflects the net
  // (Stripe transfers are net-of-fee). For platform_settled reads, we
  // compute net from the settlement's fee ratio.
  // ---------------------------------------------------------------------------

  async getWriterEarnings(writerId: string): Promise<WriterEarnings> {
    const config = await loadConfig()

    // The pending/paid SUB-SPLIT stays read_events-derived (the ledger does not
    // model the platform_settled→writer_paid distinction — see the cutover spec).
    // Each bucket is the carve-reduced net: read_net − LIVE root carve
    // (held|released|paid) — the deeper chain shares telescope within a root's
    // gross, carved by inspirers, not the author. The LEFT JOIN is a no-op dark.
    const { rows } = await pool.query<{
      pending_transfer_pence: string
      paid_out_pence: string
      read_count: string
    }>(
      `SELECT
         COALESCE(SUM(
           CASE WHEN r.state = 'platform_settled'
             THEN ${readNetSql('r.chargeable_pence', '$2')} - COALESCE(acc.live_pence, 0)
             ELSE 0
           END
         ), 0) AS pending_transfer_pence,
         COALESCE(SUM(
           CASE WHEN r.state = 'writer_paid'
             THEN ${readNetSql('r.chargeable_pence', '$2')} - COALESCE(acc.live_pence, 0)
             ELSE 0
           END
         ), 0) AS paid_out_pence,
         COUNT(*) AS read_count
       FROM read_events r
       LEFT JOIN (
         -- ROOT accruals only (the author's direct children).
         SELECT ta.read_event_id, SUM(ta.amount_pence) AS live_pence
         FROM tribute_accruals ta
         JOIN tributes t ON t.id = ta.tribute_id
         WHERE ta.state IN ('released', 'paid')
           AND t.parent_tribute_id IS NULL
         GROUP BY ta.read_event_id
       ) acc ON acc.read_event_id = r.id
       WHERE r.writer_id = $1
         AND r.state IN ('platform_settled', 'writer_paid')
         AND r.publication_id IS NULL`,
      [writerId, config.platformFeeBps]
    )

    const row = rows[0]

    // Reserved, pending redirect (compliance condition #4) — Σ('released')
    // accruals of every tribute this account is the PARTY-OF-FUNDS for
    // (author_account_id = X): the article author for ROOT tributes, an inspirer
    // node for its CHILDREN. Dial A: 'released' is the only reserved state (money
    // frozen for a CONSENTED, onboarding party, not yet paid out — no held state
    // exists). `reserved_root_pence` is the ROOT-only subset — the released carve
    // on X's OWN articles — which is what reduces X's earned headline below the
    // ledger figure (the child reserve is X's onward-redirect share of OTHERS'
    // reads, not a reduction of X's read earnings). Both 0 dark.
    const { rows: resRows } = await pool.query<{
      reserved_pence: string
      reserved_root_pence: string
    }>(
      `SELECT
         COALESCE(SUM(ta.amount_pence), 0) AS reserved_pence,
         COALESCE(SUM(ta.amount_pence) FILTER (WHERE t.parent_tribute_id IS NULL), 0) AS reserved_root_pence
         FROM tribute_accruals ta
         JOIN tributes t ON t.id = ta.tribute_id
        WHERE t.author_account_id = $1
          AND ta.state = 'released'`,
      [writerId]
    )

    // CUTOVER (item 3 final phase): the earned-total headline now reads the
    // append-only ledger, not read_events. ledger_writer_earned = read_net −
    // paid_root_carve (the held carve stays out of the ledger, guard #7); the
    // remaining held|released ROOT carve on X's own reads is reserved (still X's
    // money, conditionally directed), so the free-and-clear headline subtracts it:
    //   earningsTotal = (read_net − paid_root_carve) − held|released_root_carve
    //                 = read_net − live_root_carve            (≡ the old formula).
    // Dark: paid_root_carve = reserved_root = 0 ⇒ earningsTotal = read_net = the
    // ledger figure. The settlement-ledger-parity test pins this to the penny.
    const { rows: ledRows } = await pool.query<{ earned_pence: string }>(
      `SELECT COALESCE(earned_pence, 0) AS earned_pence
         FROM ledger_writer_earned WHERE account_id = $1`,
      [writerId]
    )
    const ledgerEarned = parseInt(ledRows[0]?.earned_pence ?? '0', 10)
    const reservedRoot = parseInt(resRows[0].reserved_root_pence, 10)

    return {
      writerId,
      earningsTotalPence: ledgerEarned - reservedRoot,
      pendingTransferPence: parseInt(row.pending_transfer_pence, 10),
      paidOutPence: parseInt(row.paid_out_pence, 10),
      reservedPence: parseInt(resRows[0].reserved_pence, 10),
      readCount: parseInt(row.read_count, 10),
    }
  }

  // ---------------------------------------------------------------------------
  // getPerArticleEarnings — per-article breakdown for the dashboard
  //
  // Per ADR §I.2: "The dashboard must show settled per-article revenue, with
  // a clear breakdown of platform-settled and writer-paid amounts."
  //
  // Returns articles sorted by total net earnings descending.
  // Only includes articles with at least one platform_settled or writer_paid read.
  // ---------------------------------------------------------------------------

  async getPerArticleEarnings(writerId: string): Promise<ArticleEarnings[]> {
    const config = await loadConfig()

    const { rows } = await pool.query<{
      article_id: string
      title: string
      nostr_d_tag: string
      published_at: string | null
      read_count: string
      net_earnings_pence: string
      pending_pence: string
      paid_pence: string
    }>(
      `SELECT
         a.id AS article_id,
         a.title,
         a.nostr_d_tag,
         a.published_at,
         COUNT(r.id) AS read_count,
         COALESCE(SUM(${readNetSql('r.chargeable_pence', '$2')} - COALESCE(acc.live_pence, 0)), 0) AS net_earnings_pence,
         COALESCE(SUM(CASE WHEN r.state = 'platform_settled'
           THEN ${readNetSql('r.chargeable_pence', '$2')} - COALESCE(acc.live_pence, 0) ELSE 0 END), 0) AS pending_pence,
         COALESCE(SUM(CASE WHEN r.state = 'writer_paid'
           THEN ${readNetSql('r.chargeable_pence', '$2')} - COALESCE(acc.live_pence, 0) ELSE 0 END), 0) AS paid_pence
       FROM read_events r
       JOIN articles a ON a.id = r.article_id
       LEFT JOIN (
         -- ROOT accruals only (the author carves its direct children; deeper
         -- chain shares live within a root's gross — Phase-5 telescoping).
         SELECT ta.read_event_id, SUM(ta.amount_pence) AS live_pence
         FROM tribute_accruals ta
         JOIN tributes t ON t.id = ta.tribute_id
         WHERE ta.state IN ('released', 'paid')
           AND t.parent_tribute_id IS NULL
         GROUP BY ta.read_event_id
       ) acc ON acc.read_event_id = r.id
       WHERE r.writer_id = $1
         AND r.state IN ('platform_settled', 'writer_paid')
         AND r.publication_id IS NULL
       GROUP BY a.id, a.title, a.nostr_d_tag, a.published_at
       ORDER BY net_earnings_pence DESC`,
      [writerId, config.platformFeeBps]
    )

    return rows.map(r => ({
      articleId: r.article_id,
      title: r.title,
      dTag: r.nostr_d_tag,
      publishedAt: r.published_at,
      readCount: parseInt(r.read_count, 10),
      netEarningsPence: parseInt(r.net_earnings_pence, 10),
      pendingPence: parseInt(r.pending_pence, 10),
      paidPence: parseInt(r.paid_pence, 10),
    }))
  }

  // ---------------------------------------------------------------------------
  // runPayoutCycle — called by the daily payout worker
  // Processes all eligible writers in one pass
  //
  // Note: The payout amount is net-of-fee. The platform fee was already
  // deducted at settlement (Stage 2). Stripe transfers move only the
  // writer's share.
  // ---------------------------------------------------------------------------

  async runPayoutCycle(): Promise<{ processed: number; totalPaidPence: number }> {
    // §1.2 halt gate: if the ledger-reconciliation job flagged a reader-tab
    // divergence, refuse to move any money out until a human reconciles and
    // clears the flag. Gates the resume sweep too — freeze ALL outbound.
    if (await isPayoutsHalted(pool)) {
      logger.warn('Payouts halted (ledger reconciliation mismatch) — skipping writer payout cycle')
      return { processed: 0, totalPaidPence: 0 }
    }

    // Resume any pending payouts from previous runs first. A pending row means
    // we committed the reservation but crashed before Stripe returned or before
    // the 'initiated' update landed. Stable idempotency keys make the Stripe
    // call safe to retry — if the transfer was already created on a prior
    // attempt, Stripe returns the same response rather than creating a second.
    await this.resumePendingWriterPayouts()

    const config = await loadConfig()

    // Find writers with enough platform_settled balance and completed KYC.
    // Combines read_events earnings with writer subscription earnings (F1).
    // (F9 removed the former upvote-earnings arm; voting is now free.)
    // FIX #4: Compute net amounts (after platform fee) for payout eligibility.
    //
    // Rounding: the platform fee is applied per-row then summed, not applied
    // once to the grand total. This matches the "platform absorbs rounding
    // dust" rule the settlement and split paths already follow
    // (tests/payout-math.test.ts:183, tests/settlement.test.ts:135). A 1p
    // read at 8% bps floors the fee to 0, so the writer keeps the full
    // penny; summing-then-flooring would instead collapse N of those pennies
    // into a single non-zero fee. The per-row form is very slightly
    // writer-favourable (up to N-1 pence across N rows) and intentional.
    // Tribute carve (Upstream Edges Phase 3 + Phase-5 chains) folds into the
    // writer's net:
    //   net = Σ per-read net (reads + subs) − Σ ROOT accruals on the reads
    //         being paid this cycle  (carve)
    // The author is the depth-0 carving party: it carves its DIRECT children —
    // the ROOT tributes (parent_tribute_id IS NULL), released|paid (each root's
    // disposition is the second leg: released→paid to the root inspirer). Deeper
    // chain shares are carved by the inspirer nodes (runTributePayoutCycle), not
    // the author. Dial A: a live tribute never un-consents, so there is no swept
    // ROOT share to return here (the held/swept/returned machinery is gone). The
    // carve CTE is a no-op when dark.
    const { rows: eligibleWriters } = await pool.query<{
      writer_id: string
      gross_pence: string
      net_pence: string
      stripe_connect_id: string
    }>(
      // F2: `AND publication_id IS NULL` excludes publication-article reads from
      // the individual writer cycle — the publication payout cycle pools them.
      // F1: the `sub` CTE folds WRITER subscription earnings (already NET) into
      // the base, added as a separate term (NOT through readNetSql, which would
      // re-apply the fee). Publication subscriptions (publication_id NOT NULL)
      // are excluded here — their income flows through the publication pool.
      `WITH base AS (
         SELECT earnings.writer_id,
                SUM(earnings.chargeable_pence) AS gross_pence,
                SUM(${readNetSql('earnings.chargeable_pence', '$2')}) AS net_pence
         FROM (
           SELECT writer_id, chargeable_pence
           FROM read_events
           WHERE state = 'platform_settled' AND writer_payout_id IS NULL
             AND publication_id IS NULL
         ) AS earnings
         GROUP BY earnings.writer_id
       ),
       sub AS (
         SELECT writer_id, SUM(amount_pence) AS sub_net_pence
         FROM subscription_events
         WHERE event_type = 'subscription_earning'
           AND writer_id IS NOT NULL
           AND publication_id IS NULL
           AND writer_payout_id IS NULL
           AND settled_at IS NOT NULL
         GROUP BY writer_id
       ),
       carve AS (
         SELECT re.writer_id, SUM(ta.amount_pence) AS carve_pence
         FROM tribute_accruals ta
         JOIN read_events re ON re.id = ta.read_event_id
         JOIN tributes t ON t.id = ta.tribute_id
         WHERE re.state = 'platform_settled' AND re.writer_payout_id IS NULL
           AND re.publication_id IS NULL
           AND t.parent_tribute_id IS NULL
           AND ta.state IN ('released', 'paid')
         GROUP BY re.writer_id
       ),
       candidates AS (
         SELECT writer_id FROM base
         UNION
         SELECT writer_id FROM sub
       )
       SELECT c.writer_id,
              COALESCE(base.gross_pence, 0) AS gross_pence,
              (COALESCE(base.net_pence, 0) + COALESCE(sub.sub_net_pence, 0)
                 - COALESCE(carve.carve_pence, 0)) AS net_pence,
              a.stripe_connect_id
       FROM candidates c
       JOIN accounts a ON a.id = c.writer_id
       LEFT JOIN base  ON base.writer_id  = c.writer_id
       LEFT JOIN sub   ON sub.writer_id   = c.writer_id
       LEFT JOIN carve ON carve.writer_id = c.writer_id
       WHERE a.stripe_connect_kyc_complete = TRUE
         AND a.stripe_connect_id IS NOT NULL
         AND (COALESCE(base.net_pence, 0) + COALESCE(sub.sub_net_pence, 0)
                - COALESCE(carve.carve_pence, 0)) >= $1`,
      [config.writerPayoutThresholdPence, config.platformFeeBps]
    )

    let processed = 0
    let totalPaidPence = 0

    for (const writer of eligibleWriters) {
      try {
        const netPence = parseInt(writer.net_pence, 10)
        const payoutId = await this.initiateWriterPayout(
          writer.writer_id,
          writer.stripe_connect_id,
          netPence,
        )
        if (payoutId) {
          processed++
          totalPaidPence += netPence
        }
      } catch (err) {
        logger.error({ err, writerId: writer.writer_id }, 'Payout failed for writer — continuing cycle')
      }
    }

    logger.info({ processed, totalPaidPence }, 'Payout cycle complete')
    return { processed, totalPaidPence }
  }

  // ---------------------------------------------------------------------------
  // initiateWriterPayout — single writer payout
  //
  // FIX-PROGRAMME §3: Split into two committed phases with a Stripe call in
  // between. Earlier, the entire flow ran inside one transaction with the
  // Stripe transfer created before any DB write — any later throw rolled the
  // transaction back while the transfer stayed live, orphaning writer money
  // from the ledger. Now:
  //
  //   1. reserveWriterPayout (Txn 1, committed) — insert 'pending' row and
  //      stamp read_events with writer_payout_id so no concurrent cycle can
  //      re-count them.
  //   2. stripe.transfers.create with idempotencyKey=`payout-${payoutId}`
  //      (stable — same key on any retry deduplicates against the prior
  //      transfer).
  //   3. completeWriterPayout (Txn 2, committed) — flip status to 'initiated',
  //      store stripe_transfer_id, advance reads to writer_paid.
  //
  // If we crash or throw between steps 1 and 3, the 'pending' row survives
  // and resumePendingWriterPayouts (called at cycle start) re-runs steps
  // 2–3 with the same stable key.
  // ---------------------------------------------------------------------------

  private async initiateWriterPayout(
    writerId: string,
    stripeConnectId: string,
    amountPence: number,
  ): Promise<string | null> {
    let reserved: { payoutId: string; amountPence: number } | null
    try {
      reserved = await this.reserveWriterPayout(writerId, stripeConnectId, amountPence)
    } catch (err) {
      // An ordinary outcome, not a failure: the packing overflowed the slice cap
      // and what remained was under the threshold, so Txn 1 rolled back whole
      // and the claim is released. Next cycle picks the writer up again.
      if (err instanceof PayoutBelowThresholdError) {
        logger.info({ writerId, reason: err.message }, 'Writer payout skipped this cycle')
        return null
      }
      throw err
    }
    if (!reserved) return null

    await this.completeWriterPayout(
      reserved.payoutId,
      writerId,
      stripeConnectId,
      reserved.amountPence,
    )
    return reserved.payoutId
  }

  // Txn 1: reserve — insert a 'pending' writer_payouts row and claim the
  // writer's unpaid earnings under it. Commits before any Stripe call, so the
  // audit trail exists even if the process dies mid-flight.
  private async reserveWriterPayout(
    writerId: string,
    stripeConnectId: string,
    expectedAmountPence: number,
  ): Promise<{ payoutId: string; amountPence: number } | null> {
    return withTransaction(async (client) => {
      await client.query(
        'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
        [writerId],
      )

      const config = await loadConfig()

      // Peek at the same net the eligibility query used, under the account lock,
      // to decide whether to proceed at all. This stays stale-HIGH-safe but never
      // stale-low vs the claim below: while we hold the account lock, reads only
      // ADD to platform_settled (confirmSettlement) and no other payout claims
      // this writer's rows. So a <= 0 peek means the balance was already claimed
      // by a pending payout from a prior (crashed) cycle — return cleanly with no
      // rows touched. Tribute subqueries are no-ops when dark.
      const peekRow = await client.query<{ net_pence: string }>(
        `SELECT (
           (SELECT COALESCE(SUM(${readNetSql('chargeable_pence', '$2')}), 0)
              FROM (
                SELECT chargeable_pence FROM read_events
                WHERE writer_id = $1 AND state = 'platform_settled' AND writer_payout_id IS NULL
                  AND publication_id IS NULL
              ) AS earnings)
           + (SELECT COALESCE(SUM(amount_pence), 0)
                FROM subscription_events
                WHERE writer_id = $1 AND event_type = 'subscription_earning'
                  AND publication_id IS NULL AND writer_payout_id IS NULL
                  AND settled_at IS NOT NULL)
           - (SELECT COALESCE(SUM(ta.amount_pence), 0)
                FROM tribute_accruals ta
                JOIN read_events re ON re.id = ta.read_event_id
                JOIN tributes t ON t.id = ta.tribute_id
                WHERE re.writer_id = $1 AND re.state = 'platform_settled' AND re.writer_payout_id IS NULL
                  AND re.publication_id IS NULL
                  AND t.parent_tribute_id IS NULL
                  AND ta.state IN ('released', 'paid'))
         ) AS net_pence`,
        [writerId, config.platformFeeBps],
      )

      const peekAmountPence = parseInt(peekRow.rows[0].net_pence, 10)

      if (peekAmountPence <= 0) {
        logger.warn(
          { writerId, expected: expectedAmountPence },
          'Writer has no unreserved balance — skipping (likely claimed by a pending payout)',
        )
        return null
      }

      // Insert the payout row first so we have an id to stamp onto the rows we
      // claim; the amount is patched from the claim below.
      const payoutRow = await client.query<{ id: string }>(
        `INSERT INTO writer_payouts (
           writer_id, amount_pence, stripe_connect_id, status
         ) VALUES ($1, 0, $2, 'pending')
         RETURNING id`,
        [writerId, stripeConnectId],
      )
      const payoutId = payoutRow.rows[0].id

      // Audit F6 (2026-07-05): claim rows FIRST and derive the transfer amount
      // from exactly what we claimed (RETURNING), rather than summing a subquery
      // then blanket-UPDATE-ing. The old form left a settlement race open: a read
      // advancing accrued→platform_settled in a concurrent confirmSettlement
      // (which does NOT hold this writer's account lock) got stamped with our
      // payout_id by the unconstrained UPDATE but was absent from the pre-summed
      // amount — the writer was underpaid for rows marked writer_paid. Summing the
      // claimed set closes it.
      //
      // The RETURNING list gained id / chargeable_pence / tab_settlement_id for
      // the allocation packer (§3.3b): the funding step needs each read as its
      // own unit. The CLAIM and the net arithmetic are untouched — `readNet` is
      // still Σ of the same per-row-then-floor net — so no money question is
      // reopened and every conformance test stays green.
      const { rows: claimedReads } = await client.query<{
        id: string
        net_pence: string
        chargeable_pence: number
        tab_settlement_id: string | null
      }>(
        `UPDATE read_events
         SET writer_payout_id = $1
         WHERE writer_id = $2
           AND state = 'platform_settled'
           AND writer_payout_id IS NULL
           AND publication_id IS NULL
         RETURNING id, chargeable_pence, tab_settlement_id,
                   ${readNetSql('chargeable_pence', '$3')} AS net_pence`,
        [payoutId, writerId, config.platformFeeBps],
      )
      const readNet = claimedReads.reduce((s, r) => s + parseInt(r.net_pence, 10), 0)

      // F1: claim WRITER subscription earnings (already NET) under this payout.
      // Collection gate (migration 146): only earnings whose reader-tab debit
      // was actually collected — settled_at stamped by confirmSettlement when
      // the tab settlement lands, or at charge time when pre-paid credit funded
      // it. Without the gate a card-less reader's uncollectible charge paid the
      // writer real money (2026-07-06 audit P0). writer_payout_id makes each
      // earning claimed exactly once; rolled back with the reads on a failed
      // transfer (rollbackWriterPayoutRows, which never touches settled_at).
      const { rows: claimedSubs } = await client.query<{
        id: string
        amount_pence: number
      }>(
        `UPDATE subscription_events
         SET writer_payout_id = $1
         WHERE writer_id = $2
           AND event_type = 'subscription_earning'
           AND publication_id IS NULL
           AND writer_payout_id IS NULL
           AND settled_at IS NOT NULL
         RETURNING id, amount_pence`,
        [payoutId, writerId],
      )
      const subNet = claimedSubs.reduce((s, r) => s + r.amount_pence, 0)

      // ROOT tribute carve on the reads we JUST claimed (released|paid — each
      // root's disposition is the second leg). Computed against the claimed set
      // (writer_payout_id = $1) so it can't drift from what we're paying. No-op
      // when dark.
      const { rows: [carveRow] } = await client.query<{ carve_pence: string }>(
        `SELECT COALESCE(SUM(ta.amount_pence), 0) AS carve_pence
         FROM tribute_accruals ta
         JOIN read_events re ON re.id = ta.read_event_id
         JOIN tributes t ON t.id = ta.tribute_id
         WHERE re.writer_payout_id = $1
           AND t.parent_tribute_id IS NULL
           AND ta.state IN ('released', 'paid')`,
        [payoutId],
      )
      const carve = parseInt(carveRow.carve_pence, 10)

      const lockedAmountPence = readNet + subNet - carve

      if (lockedAmountPence <= 0) {
        // Defensive: the peek was > 0 so this is near-impossible under the lock;
        // throw to roll back the payout row + all claims rather than commit an
        // empty payout. The cycle's per-writer try/catch logs and continues.
        throw new Error(
          `Writer payout net <= 0 after claim (writer=${writerId}, peek=${peekAmountPence}) — rolling back`,
        )
      }

      if (lockedAmountPence !== expectedAmountPence) {
        logger.warn(
          { writerId, expected: expectedAmountPence, actual: lockedAmountPence },
          'Balance changed between eligibility check and lock — using locked amount',
        )
      }

      // --- Funding (§3.3) — everything above this line is unchanged ----------
      // Attribution is settled: `lockedAmountPence` is what this writer is owed
      // and how it was computed has not moved. What follows only decides WHICH
      // CHARGES pay it, and splits the payout into one child transfer per charge
      // drawn on. Flag off ⇒ no children, and completeWriterPayout takes the
      // single-transfer path exactly as before.
      const finalAmountPence = allocatedFundsEnabled()
        ? await this.packWriterPayout(client, {
            payoutId,
            writerId,
            config,
            claimedReads,
            claimedSubs,
            carve,
            lockedAmountPence,
          })
        : lockedAmountPence

      await client.query(
        `UPDATE writer_payouts SET amount_pence = $1 WHERE id = $2`,
        [finalAmountPence, payoutId],
      )

      logger.info(
        { payoutId, writerId, amountPence: finalAmountPence },
        'Writer payout reserved (pending Stripe transfer)',
      )

      return { payoutId, amountPence: finalAmountPence }
    })
  }

  // ---------------------------------------------------------------------------
  // packWriterPayout — the funding half of Txn 1 (§3.3b/§3.3c).
  //
  // Runs INSIDE reserveWriterPayout's transaction, after the claim has committed
  // its amount in memory and before anything is written back. Returns the amount
  // actually placed, which may be smaller than the claimed amount in exactly one
  // legitimate way: the packing overflowed `payout_max_slices` and the overflow
  // units were un-claimed to roll to the next cycle. That difference MUST happen
  // inside this transaction, or the ledger and Stripe disagree.
  // ---------------------------------------------------------------------------
  private async packWriterPayout(
    client: PoolClient,
    input: {
      payoutId: string
      writerId: string
      config: { platformFeeBps: number; payoutMaxSlices: number; writerPayoutThresholdPence: number }
      claimedReads: Array<{
        id: string
        net_pence: string
        chargeable_pence: number
        tab_settlement_id: string | null
      }>
      claimedSubs: Array<{ id: string; amount_pence: number }>
      carve: number
      lockedAmountPence: number
    },
  ): Promise<number> {
    const { payoutId, writerId, config, claimedReads, claimedSubs, carve, lockedAmountPence } = input

    // --- Units: reads ---------------------------------------------------------
    // A unit's fee is the fee that ALREADY existed on that row — gross minus the
    // net the claim computed — so the packer introduces no rounding anywhere.
    // Chargeable, never the list price: the free allowance is a gift, so a gifted
    // penny is charged to nobody and earns nobody (migration 164).
    const readUnits: EarningUnit[] = claimedReads.map((r) => {
      const net = perReadNetPence(r.chargeable_pence, config.platformFeeBps)
      return {
        id: r.id,
        source: 'read_events' as const,
        netPence: net,
        feePence: r.chargeable_pence - net,
        preferredSettlementIds: r.tab_settlement_id ? [r.tab_settlement_id] : [],
      }
    })

    // --- Units: subscription earnings ----------------------------------------
    // `amount_pence` is ALREADY net (logSubscriptionCharge floors the fee per
    // charge), so the fee must be recovered from the paired subscription_charge.
    // The pairing key is (subscription_id, period_start, period_end) — both rows
    // are inserted together by logSubscriptionCharge — and it is required to
    // match EXACTLY ONE charge. Zero or several ⇒ fee 0, the safe direction: an
    // unclaimed fee is dust the Balance-Transfer sweep reclaims, while an
    // over-claimed one over-draws the charge and Stripe rejects the transfer.
    const subUnits: EarningUnit[] = []
    if (claimedSubs.length > 0) {
      const { rows: subRows } = await client.query<{
        id: string
        amount_pence: number
        tab_settlement_id: string | null
        pair_count: string
        charge_pence: number | null
      }>(
        `SELECT e.id, e.amount_pence, e.tab_settlement_id,
                p.pair_count, p.charge_pence
           FROM subscription_events e
           LEFT JOIN LATERAL (
             SELECT count(*) AS pair_count, min(c.amount_pence) AS charge_pence
               FROM subscription_events c
              WHERE c.subscription_id = e.subscription_id
                AND c.event_type = 'subscription_charge'
                AND c.period_start IS NOT DISTINCT FROM e.period_start
                AND c.period_end   IS NOT DISTINCT FROM e.period_end
           ) p ON TRUE
          WHERE e.id = ANY($1)`,
        [claimedSubs.map((s) => s.id)],
      )
      for (const r of subRows) {
        const paired =
          parseInt(r.pair_count, 10) === 1 && r.charge_pence !== null
            ? Math.max(0, r.charge_pence - r.amount_pence)
            : 0
        subUnits.push({
          id: r.id,
          source: 'subscription_events',
          netPence: r.amount_pence,
          feePence: paired,
          // NULL is correct and expected for a credit-funded earning: no charge
          // exists, so it has no preference and belongs in the residual.
          preferredSettlementIds: r.tab_settlement_id ? [r.tab_settlement_id] : [],
        })
      }
    }

    // --- The tribute carve, apportioned across the read units ----------------
    // Today the carve is one set-level SUM subtracted once. A naive per-read
    // deduction can drive a unit's net below zero, and flooring it at 0 would
    // make Σ(units) > lockedAmountPence — the writer overpaid, the carve
    // under-collected, and the overpay silently ratified in both Stripe and the
    // ledger, because the parent's amount is restated from the placed units.
    // apportionCarve carries the overflow instead, and the two assertions below
    // turn the whole error class into a rolled-back transaction.
    //
    // Inert while TRIBUTES_ENABLED is off — which is precisely why the
    // assertions matter: this is code that will be switched on years from now by
    // someone who was not here.
    const { units: carvedReads, zeroed, carveRemaining } = apportionCarve(readUnits, carve)

    if (carveRemaining !== 0) {
      throw new Error(
        `Writer payout carve unsatisfiable (payout=${payoutId}, writer=${writerId}, remaining=${carveRemaining}) — rolling back`,
      )
    }

    const units = [...carvedReads, ...subUnits]
    const unitTotal = units.reduce((s, u) => s + u.netPence, 0)
    if (unitTotal !== lockedAmountPence) {
      throw new Error(
        `Writer payout unit sum ${unitTotal} != locked amount ${lockedAmountPence} (payout=${payoutId}, writer=${writerId}) — rolling back`,
      )
    }

    // --- Lock the candidate charges, then pack -------------------------------
    // Locked in one statement in primary-key order, because the PACK order is
    // data-dependent and must not also be the lock order (two concurrent packers
    // would take the same rows in opposite orders and deadlock).
    const settlementIds = [
      ...new Set(units.flatMap((u) => u.preferredSettlementIds)),
    ]
    const sources = await lockFundingSources(client, settlementIds)

    const { slices, overflow, zeroNet } = packUnits(units, sources, {
      maxSlices: config.payoutMaxSlices,
    })

    // --- Overflow: un-claim, so it rolls to the next cycle -------------------
    if (overflow.length > 0) {
      const overflowReads = overflow.filter((u) => u.source === 'read_events').map((u) => u.id)
      const overflowSubs = overflow.filter((u) => u.source === 'subscription_events').map((u) => u.id)
      if (overflowReads.length > 0) {
        await client.query(
          `UPDATE read_events SET writer_payout_id = NULL WHERE id = ANY($1)`,
          [overflowReads],
        )
      }
      if (overflowSubs.length > 0) {
        await client.query(
          `UPDATE subscription_events SET writer_payout_id = NULL WHERE id = ANY($1)`,
          [overflowSubs],
        )
      }
      logger.warn(
        { payoutId, writerId, overflow: overflow.length, maxSlices: config.payoutMaxSlices },
        'Writer payout exceeded the slice cap — overflow units un-claimed and rolled to the next cycle',
      )
    }

    // --- Children + unit stamps ----------------------------------------------
    const childIds = await insertChildren(client, 'writer_payouts', payoutId, slices)

    for (let i = 0; i < slices.length; i++) {
      const childId = childIds[i]
      const readIds = slices[i].units.filter((u) => u.source === 'read_events').map((u) => u.id)
      const subIds = slices[i].units.filter((u) => u.source === 'subscription_events').map((u) => u.id)
      if (readIds.length > 0) {
        await client.query(
          `UPDATE read_events SET payout_transfer_id = $1 WHERE id = ANY($2)`,
          [childId, readIds],
        )
      }
      if (subIds.length > 0) {
        await client.query(
          `UPDATE subscription_events SET payout_transfer_id = $1 WHERE id = ANY($2)`,
          [childId, subIds],
        )
      }
    }

    // A carve-zeroed read keeps its parent claim and gets no child: its money
    // went to the carve, so there is nothing to transfer for it, and Stripe
    // rejects amount: 0. It advances to writer_paid at parent completion along
    // with any other childless claim row.
    if (zeroed.length > 0) {
      logger.info(
        { payoutId, writerId, zeroed: zeroed.length },
        'Reads fully consumed by the tribute carve — claimed, but no transfer',
      )
    }

    // Same childless-claim treatment for units that arrived at the packer with
    // no net at all (a fully-gifted read, or a 1p-chargeable read whose net
    // floors to 0): claimed, no child, any fee left as dust. Never un-claimed —
    // packing is deterministic, so un-claiming would re-present the same
    // zero-net row every cycle.
    if (zeroNet.length > 0) {
      logger.info(
        { payoutId, writerId, zeroNet: zeroNet.length },
        'Zero-net units (gifted or fee-floored) — claimed, but no transfer',
      )
    }

    const placedPence = slices.reduce((s, sl) => s + sl.netPence, 0)

    // The second place the claimed and paid amounts can legitimately differ.
    // Under the threshold after overflow, this payout should not happen at all
    // — throw so Txn 1 rolls back whole and the writer is picked up next cycle.
    if (placedPence < config.writerPayoutThresholdPence) {
      throw new PayoutBelowThresholdError(
        `Writer payout fell below the threshold after slice-cap overflow (placed=${placedPence}, threshold=${config.writerPayoutThresholdPence}, writer=${writerId})`,
      )
    }

    return placedPence
  }

  // Stripe call + Txn 2: flip 'pending' → 'initiated', advance reserved rows
  // to writer_paid. Uses stable idempotencyKey `payout-${payoutId}` so a retry
  // after a crash lands on the same Stripe transfer rather than creating a
  // duplicate.
  private async completeWriterPayout(
    payoutId: string,
    writerId: string,
    stripeConnectId: string,
    amountPence: number,
  ): Promise<void> {
    // Keyed on the DATA, not the flag. A payout reserved with segregation ON
    // must complete through its children even if an operator flips the flag off
    // mid-flight — the children exist, their draws are recorded, and one
    // aggregate transfer would double-pay against them.
    if (await hasChildren('writer_payouts', payoutId)) {
      await this.completeWriterPayoutChildren(payoutId, writerId, stripeConnectId)
      return
    }

    const outcome = await executeStripeIdempotent(
      'writer-payout',
      `payout-${payoutId}`,
      () => this.stripe.transfers.create({
        amount: amountPence,
        currency: 'gbp',
        destination: stripeConnectId,
        metadata: {
          platform: 'all.haus',
          writer_id: writerId,
          payout_id: payoutId,
        },
      }, {
        idempotencyKey: `payout-${payoutId}`,
      }),
      isTerminalTransferError,
    )
    if (!outcome.ok) {
      // Terminal rejection (e.g. the destination's transfers capability was
      // revoked): Stripe created NO transfer, so there is no id to key anything
      // on and the row would sit 'pending' forever, its claimed reads frozen,
      // resume retrying every cycle (the payout-side twin of the settlement
      // orphan). Note this is now the ONLY thing that resolves such a row:
      // transfer.failed was never going to arrive for a platform→connected
      // transfer, which audit F4 measured and closed on 2026-07-30.
      // Mark the payout failed and release its earnings so the next cycle re-pays
      // under a fresh id. (Ambiguous errors never reach here — the primitive
      // re-throws them so resume retries with the stable key → never double-pay.)
      await this.failWriterPayoutTerminal(
        payoutId,
        writerId,
        stripeErrorCode(outcome.err, 'transfer_rejected'),
      )
      return
    }
    const transfer = outcome.object

    await withTransaction(async (client) => {
      // Audit F4 (2026-07-06): key completion off the successful transfers.create
      // response, not a transfer.paid webhook. Stripe does NOT emit transfer.paid/
      // failed for platform→connected transfers (only transfer.created/updated/
      // reversed), so the old 'initiated'→'completed' webhook step was unreachable
      // and every payout stalled at 'initiated' forever. The money moves at create
      // time and the ledger posts here regardless, so a created transfer IS the
      // completion signal. A later Stripe reversal is caught by transfer.reversed
      // (reverseWriterPayout). Guard the flip on status='pending' and gate the
      // ledger emit on its rowCount so a crash-resume (same stable key) can't post
      // the entry twice.
      const flipped = await client.query(
        `UPDATE writer_payouts
         SET status = 'completed', completed_at = now(), stripe_transfer_id = $1
         WHERE id = $2 AND status = 'pending'`,
        [transfer.id, payoutId],
      )

      await client.query(
        `UPDATE read_events
         SET state = 'writer_paid',
             state_updated_at = now()
         WHERE writer_payout_id = $1
           AND state = 'platform_settled'`,
        [payoutId],
      )

      // Ledger: writer credit — money received. +amount, counterparty =
      // platform (NULL). SUM of these == historic writer payout sums. Gated on
      // the pending→completed flip so resume can't post it twice.
      if (flipped.rowCount! > 0) {
        await recordLedger(client, {
          accountId: writerId,
          counterpartyId: null,
          amountPence: amountPence,
          triggerType: 'writer_payout',
          refTable: 'writer_payouts',
          refId: payoutId,
        })
      }
    })

    logger.info(
      { payoutId, writerId, amountPence, stripeTransferId: transfer.id },
      'Writer payout completed',
    )
  }

  // ---------------------------------------------------------------------------
  // completeWriterPayoutChildren — the segregated path (§3.3c).
  //
  // One transfer per funding charge, each completed or failed independently,
  // then the parent settled once no child is left pending. Because the packing
  // committed in Txn 1, this is a REPLAY: it never re-packs, so a crash-resume
  // reproduces exactly the same transfers under exactly the same keys.
  // ---------------------------------------------------------------------------
  private async completeWriterPayoutChildren(
    payoutId: string,
    writerId: string,
    stripeConnectId: string,
  ): Promise<void> {
    const spec = this.writerChildSpec(payoutId, writerId, stripeConnectId)

    const result = await executePendingChildren(this.stripe, spec)

    const completion = await withTransaction((client) =>
      this.finaliseWriterPayoutParent(client, payoutId),
    )

    logger.info(
      {
        payoutId,
        writerId,
        children: result,
        parentCompleted: completion.completed,
        amountPence: completion.paidPence,
      },
      'Writer payout children executed',
    )
  }

  /** The writer cycle's money semantics, handed to the shared child lifecycle. */
  private writerChildSpec(
    payoutId: string,
    writerId: string,
    stripeConnectId: string,
  ): ChildCycleSpec {
    return {
      parentTable: 'writer_payouts',
      parentId: payoutId,
      destination: stripeConnectId,
      metadata: { writer_id: writerId, payout_id: payoutId },

      postLedger: async (client, child) => {
        // Writer credit — money received. +amount, counterparty = platform
        // (NULL). One entry PER CHILD, at that child's own completion, for its
        // own net. The ref stays the PARENT `writer_payouts` row: nothing
        // forbids N entries per ref (writer_accrual already posts one per read),
        // and keeping the ref inside the known set is what stops
        // reconcile-ledger's ledger_orphans default-deny catch-all halting every
        // payout on an unrecognised ref_table.
        await recordLedger(client, {
          accountId: writerId,
          counterpartyId: null,
          amountPence: child.net_pence,
          triggerType: 'writer_payout',
          refTable: 'writer_payouts',
          refId: payoutId,
        })
      },

      advanceUnits: async (client, child) => {
        await client.query(
          `UPDATE read_events
              SET state = 'writer_paid', state_updated_at = now()
            WHERE payout_transfer_id = $1
              AND state = 'platform_settled'`,
          [child.id],
        )
      },

      releaseUnits: async (client, child) => {
        await this.releaseWriterChildRows(client, child)
      },
    }
  }

  // ---------------------------------------------------------------------------
  // releaseWriterChildRows — the per-child twin of rollbackWriterPayoutRows.
  //
  // Releases EXACTLY the rows carrying this child's id — siblings and parent
  // untouched — and reuses the same state filters, which are load-bearing for
  // the chargeback interaction: a read the planner flipped to 'charged_back'
  // mid-flight has already been ledger-reversed as if paid, so overwriting it
  // back to platform_settled would erase the marker and re-pay the writer for a
  // clawed-back read. It keeps its terminal state and loses only its pointers.
  // ---------------------------------------------------------------------------
  private async releaseWriterChildRows(
    client: PoolClient,
    child: ChildRow,
  ): Promise<void> {
    await client.query(
      `UPDATE read_events
          SET state = 'platform_settled',
              writer_payout_id = NULL,
              payout_transfer_id = NULL,
              state_updated_at = now()
        WHERE payout_transfer_id = $1
          AND state = 'platform_settled'`,
      [child.id],
    )

    await client.query(
      `UPDATE read_events
          SET writer_payout_id = NULL,
              payout_transfer_id = NULL
        WHERE payout_transfer_id = $1
          AND state = 'charged_back'`,
      [child.id],
    )

    await client.query(
      `UPDATE subscription_events
          SET writer_payout_id = NULL,
              payout_transfer_id = NULL
        WHERE payout_transfer_id = $1`,
      [child.id],
    )
  }

  /**
   * Settle the parent once no child is pending, and advance the claim rows that
   * never had a child at all — reads whose net the tribute carve consumed
   * entirely. They were claimed and their money went to the carve, so they are
   * paid in the only sense that applies; leaving them 'platform_settled' would
   * let the next cycle claim and pay them a second time.
   */
  private async finaliseWriterPayoutParent(client: PoolClient, payoutId: string) {
    const completion = await completeParentIfSettled(client, 'writer_payouts', payoutId)
    if (completion.completed) {
      await client.query(
        `UPDATE read_events
            SET state = 'writer_paid', state_updated_at = now()
          WHERE writer_payout_id = $1
            AND payout_transfer_id IS NULL
            AND state = 'platform_settled'`,
        [payoutId],
      )
    }
    return completion
  }

  // Resume any writer_payouts stuck in 'pending' from prior runs. Safe to
  // call repeatedly — the stable idempotency key means Stripe returns the
  // already-created transfer if one exists, or creates it exactly once.
  async resumePendingWriterPayouts(): Promise<void> {
    const { rows } = await pool.query<{
      id: string
      writer_id: string
      amount_pence: number
      stripe_connect_id: string
    }>(
      `SELECT id, writer_id, amount_pence, stripe_connect_id
       FROM writer_payouts
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    )

    if (rows.length === 0) return

    logger.info({ count: rows.length }, 'Resuming pending writer payouts')

    for (const row of rows) {
      try {
        await this.completeWriterPayout(
          row.id,
          row.writer_id,
          row.stripe_connect_id,
          row.amount_pence,
        )
      } catch (err) {
        logger.error(
          { err, payoutId: row.id, writerId: row.writer_id },
          'Failed to resume pending writer payout — will retry next cycle',
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // reverseWriterPayout — Stripe webhook on transfer.reversed for a WRITER
  // payout (F4). Funds were clawed back to the platform — possibly PARTIALLY:
  // Stripe emits transfer.reversed for partial reversals too, carrying the
  // CUMULATIVE transfer.amount_reversed (2026-07-06 audit residual: the old
  // handler posted −amount_pence and terminally flipped 'reversed' on any
  // event, debiting a £200 payout £200 for a £50 partial reversal).
  //
  // Idempotency is ledger-derived, not status-claimed: under the row lock, the
  // posted-so-far reversal total (Σ writer_payout_reversal entries against this
  // payout row — the chargeback path posts against tab_settlements, so the refs
  // never conflate) is compared to the cumulative target and only the DELTA is
  // posted. Redelivery ⇒ delta 0 ⇒ no-op; a second partial ⇒ the increment; the
  // row flips to 'reversed' only when fully reversed. The reads stay
  // writer_paid (they WERE paid, then clawed back — the ledger captures the
  // net, the same posture as a chargeback), so there is no re-pay loop and the
  // writer's earned total simply goes negative.
  // ---------------------------------------------------------------------------
  async reverseWriterPayout(
    stripeTransferId: string,
    amountReversedPence: number | null,
  ): Promise<void> {
    const child = await findChildByTransferId(stripeTransferId)
    if (child) {
      if (child.parent_table !== 'writer_payouts') return
      await this.reverseWriterPayoutChild(child, amountReversedPence)
      return
    }

    await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; writer_id: string; amount_pence: number }>(
        `SELECT id, writer_id, amount_pence
           FROM writer_payouts
          WHERE stripe_transfer_id = $1 AND status IN ('completed', 'reversed')
          FOR UPDATE`,
        [stripeTransferId],
      )
      if (rows.length === 0) {
        logger.warn({ stripeTransferId }, 'reverseWriterPayout: no completed payout to reverse')
        return
      }
      const { id: payoutId, writer_id: writerId, amount_pence: amountPence } = rows[0]
      // A missing amount_reversed (defensive) means full; never exceed the payout.
      const target = Math.min(amountReversedPence ?? amountPence, amountPence)
      const { rows: [posted] } = await client.query<{ posted: string }>(
        `SELECT COALESCE(-SUM(amount_pence), 0) AS posted
           FROM ledger_entries
          WHERE trigger_type = 'writer_payout_reversal'
            AND ref_table = 'writer_payouts' AND ref_id = $1`,
        [payoutId],
      )
      const delta = target - parseInt(posted.posted, 10)
      if (delta <= 0) {
        logger.info({ payoutId, stripeTransferId, target }, 'reverseWriterPayout: already posted — no-op (redelivery)')
        return
      }
      await recordLedger(client, {
        accountId: writerId,
        counterpartyId: null,
        amountPence: -delta,
        triggerType: 'writer_payout_reversal',
        refTable: 'writer_payouts',
        refId: payoutId,
      })
      if (target >= amountPence) {
        await client.query(`UPDATE writer_payouts SET status = 'reversed' WHERE id = $1`, [payoutId])
      }
      logger.warn(
        { payoutId, writerId, reversedPence: delta, cumulativePence: target, fullyReversed: target >= amountPence, stripeTransferId },
        'Writer payout reversed by Stripe',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // reverseWriterPayoutChild — one child of a multi-child payout was clawed back.
  //
  // Reverses THAT CHILD's net only; siblings and the parent's amount are
  // untouched. Idempotency is the child's own `reversed_pence` under its row lock
  // (see reverseChild) rather than the parent-level cumulative-SUM guard the
  // legacy path uses — that guard sums `writer_payout_reversal` entries against
  // the payout row, and now N children share that ref, so it cannot tell them
  // apart. Its `ref_table` scope stays load-bearing either way: the trigger type
  // is multi-table (F5 posts it against publication_payout_splits, the chargeback
  // planner against tab_settlements).
  //
  // The reads stay `writer_paid` — they WERE paid, then clawed back — so there is
  // no re-pay loop and the writer's earned total simply goes negative, the same
  // posture as a chargeback. The parent flips to 'reversed' only when every child
  // is fully reversed.
  // ---------------------------------------------------------------------------
  private async reverseWriterPayoutChild(
    child: ChildRow,
    amountReversedPence: number | null,
  ): Promise<void> {
    await withTransaction(async (client) => {
      const { rows: payoutRows } = await client.query<{ id: string; writer_id: string }>(
        `SELECT id, writer_id FROM writer_payouts WHERE id = $1 FOR UPDATE`,
        [child.parent_id],
      )
      if (payoutRows.length === 0) {
        logger.warn({ childId: child.id }, 'reverseWriterPayout: child has no parent payout')
        return
      }
      const { id: payoutId, writer_id: writerId } = payoutRows[0]

      const delta = await reverseChild(client, child, amountReversedPence)
      if (delta <= 0) {
        logger.info(
          { payoutId, childId: child.id },
          'reverseWriterPayout: already posted — no-op (redelivery)',
        )
        return
      }

      await recordLedger(client, {
        accountId: writerId,
        counterpartyId: null,
        amountPence: -delta,
        triggerType: 'writer_payout_reversal',
        refTable: 'writer_payouts',
        refId: payoutId,
      })

      // The parent is 'reversed' only when nothing of it is left standing —
      // and a PENDING sibling is still standing (§0o.3; see the constant).
      const { rows: [tally] } = await client.query<{ outstanding: string }>(
        REVERSAL_OUTSTANDING_SQL,
        [payoutId, 'writer_payouts'],
      )
      if (parseInt(tally.outstanding, 10) <= 0) {
        await client.query(
          `UPDATE writer_payouts SET status = 'reversed' WHERE id = $1`,
          [payoutId],
        )
      }

      logger.warn(
        {
          payoutId,
          childId: child.id,
          writerId,
          reversedPence: delta,
          stripeTransferId: child.stripe_transfer_id,
        },
        'Writer payout child reversed by Stripe',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // rollbackWriterPayoutRows — release everything a writer_payout claimed:
  // reads back to platform_settled (unclaimed) and claimed subscription earnings.
  // (Dial A: a writer_payout no longer claims swept ROOT tribute returns — that
  // machinery is gone.) Called by failWriterPayoutTerminal (terminal create
  // rejection); it was shared with handleFailedPayout until that transfer.failed
  // handler was deleted (audit F4, 2026-07-30), so the "can't diverge" reason for
  // extracting it is spent — it stays extracted because the rollback is the
  // delicate half and reads better named. Caller owns the transaction and the
  // writer_payouts status flip.
  // ---------------------------------------------------------------------------
  private async rollbackWriterPayoutRows(
    client: PoolClient,
    payoutId: string,
  ): Promise<void> {
    // Reads → platform_settled, unclaimed (picked up by the next cycle).
    // State-filtered: a claimed read that a chargeback flipped to 'charged_back'
    // (settlement.ts reverseSettlement) has already been ledger-reversed as if
    // paid — overwriting it back to platform_settled would erase the chargeback
    // marker and re-pay the writer for a clawed-back read on the next cycle.
    await client.query(
      `UPDATE read_events
       SET state = 'platform_settled',
           writer_payout_id = NULL,
           state_updated_at = now()
       WHERE writer_payout_id = $1
         AND state = 'platform_settled'`,
      [payoutId],
    )

    // A read the state filter above skips — flipped 'charged_back' mid-flight
    // by the chargeback planner — keeps its terminal state but must not keep a
    // claim pointer at a payout that will never pay it: null the pointer alone
    // (no state/state_updated_at touch — the chargeback stamp stays honest).
    // Symmetric with the tribute leg (rollbackTributePayoutRows voids AND
    // nulls); the planner's as-if-paid reversal residual on such reads is the
    // documented M3 artefact (chargeback.ts, claimedByPendingPayout).
    await client.query(
      `UPDATE read_events
       SET writer_payout_id = NULL
       WHERE writer_payout_id = $1
         AND state = 'charged_back'`,
      [payoutId],
    )

    // F1: release claimed subscription earnings (no state column — just unclaim).
    await client.query(
      `UPDATE subscription_events
       SET writer_payout_id = NULL
       WHERE writer_payout_id = $1`,
      [payoutId],
    )
  }

  // ---------------------------------------------------------------------------
  // failWriterPayoutTerminal — a writer transfer was rejected at create time
  // (no transfer object, no transfer.failed webhook). Flip the pending row to
  // 'failed' and release its claimed earnings for re-pay. Guarded on 'pending'
  // so a concurrent resume/webhook that already resolved it is a no-op.
  // ---------------------------------------------------------------------------
  private async failWriterPayoutTerminal(
    payoutId: string,
    writerId: string,
    reason: string,
  ): Promise<void> {
    await withTransaction(async (client) => {
      const flipped = await client.query(
        `UPDATE writer_payouts
         SET status = 'failed',
             failed_reason = COALESCE(failed_reason, $1),
             completed_at = NULL
         WHERE id = $2 AND status = 'pending'`,
        [reason, payoutId],
      )
      if (flipped.rowCount === 0) return
      await this.rollbackWriterPayoutRows(client, payoutId)
    })

    logger.warn(
      { payoutId, writerId, reason },
      'Writer payout transfer rejected by Stripe (no transfer created) — marked failed, earnings released for re-pay',
    )
  }

  // ===========================================================================
  // Publication Payout Cycle (Phase 5)
  //
  // Runs after the individual writer cycle. For each publication with enough
  // settled revenue:
  //   1. Compute the pool (gross reads minus platform fee)
  //   2. Handle per-article overrides (flat fees, article revenue shares)
  //   3. Distribute remainder by standing member shares
  //   4. Initiate Stripe transfers to each member's personal Connect account
  // ===========================================================================

  async runPublicationPayoutCycle(): Promise<{ processed: number; totalPaidPence: number }> {
    // §1.2 halt gate (see runPayoutCycle).
    if (await isPayoutsHalted(pool)) {
      logger.warn('Payouts halted (ledger reconciliation mismatch) — skipping publication payout cycle')
      return { processed: 0, totalPaidPence: 0 }
    }

    // Mint replacements for terminally-rejected splits BEFORE the resume sweep,
    // so a replacement minted now is paid on this cycle rather than the next one.
    // It reopens the completed parents it touches, which is precisely what puts
    // them back in the resume sweep's 'pending' scan below.
    try {
      const { minted, exhausted } = await this.repayFailedPublicationSplits()
      if (minted > 0 || exhausted > 0) {
        logger.info({ minted, exhausted }, 'Publication split re-pay sweep')
      }
    } catch (err) {
      // Re-pay is a recovery path, not the cycle's job — a failure here must not
      // stop this cycle from paying everyone whose split never failed.
      logger.error({ err }, 'Publication split re-pay sweep failed — continuing with the cycle')
    }

    // Resume any pending publication payouts from prior runs before taking on
    // new work. Stable idempotency keys on per-split transfers make this safe
    // to call repeatedly — Stripe deduplicates if the transfer already exists.
    await this.resumePendingPublicationPayouts()

    const config = await loadConfig()

    // Find publications with enough settled revenue
    const { rows: eligiblePubs } = await pool.query<{
      publication_id: string
      gross_pence: string
    }>(
      // Keyed on the denormalised r.publication_id — the SAME column the writer
      // cycle excludes on — never on the article's CURRENT publication
      // (2026-07-06 audit P1: keying the pool off articles.publication_id while
      // the writer cycle excludes on read_events.publication_id made the two
      // cycles non-complementary — an article joining a publication left its
      // old reads claimable by BOTH, an article leaving stranded its reads with
      // NEITHER). A read belongs to the cycle its snapshot says, forever.
      //
      // §1.3: the `subs` CTE folds publication SUBSCRIPTION earnings (already
      // NET) into the threshold — the publication twin of the writer cycle's
      // `sub` CTE, with the same collection gate (settled_at IS NOT NULL,
      // migration 146: only earnings whose reader-tab debit was actually
      // collected). The UNION candidate set lets a publication with only
      // subscription income qualify.
      `WITH reads AS (
         SELECT r.publication_id,
                SUM(r.chargeable_pence) AS gross_pence,
                SUM(${readNetSql('r.chargeable_pence', '$1')}) AS net_pence
         FROM read_events r
         WHERE r.publication_id IS NOT NULL
           AND r.state = 'platform_settled'
           -- publication_payout_id, NEVER writer_payout_id (migration 168): the
           -- two cycles are exact complements and claim into two different
           -- columns. Reusing the writer's raised 23503 on every claim, so this
           -- cycle could never pay a read-funded pool at all.
           AND r.publication_payout_id IS NULL
         GROUP BY r.publication_id
       ),
       subs AS (
         SELECT publication_id, SUM(amount_pence) AS sub_net_pence
         FROM subscription_events
         WHERE event_type = 'subscription_earning'
           AND publication_id IS NOT NULL
           AND publication_payout_id IS NULL
           AND settled_at IS NOT NULL
         GROUP BY publication_id
       ),
       candidates AS (
         SELECT publication_id FROM reads
         UNION
         SELECT publication_id FROM subs
       )
       SELECT c.publication_id,
              COALESCE(reads.gross_pence, 0) AS gross_pence
       FROM candidates c
       LEFT JOIN reads ON reads.publication_id = c.publication_id
       LEFT JOIN subs  ON subs.publication_id  = c.publication_id
       WHERE COALESCE(reads.net_pence, 0) + COALESCE(subs.sub_net_pence, 0) >= $2`,
      [config.platformFeeBps, config.writerPayoutThresholdPence]
    )

    let processed = 0
    let totalPaidPence = 0

    for (const pub of eligiblePubs) {
      try {
        const paidPence = await this.initiatePublicationPayout(
          pub.publication_id,
          parseInt(pub.gross_pence, 10),
          config.platformFeeBps,
          config.payoutMaxSlices,
        )
        if (paidPence !== null) {
          processed++
          totalPaidPence += paidPence
        }
      } catch (err) {
        logger.error({ err, publicationId: pub.publication_id }, 'Publication payout failed — continuing cycle')
      }
    }

    logger.info({ processed, totalPaidPence }, 'Publication payout cycle complete')
    return { processed, totalPaidPence }
  }

  // ---------------------------------------------------------------------------
  // initiatePublicationPayout — single publication payout
  //
  // FIX-PROGRAMME §4: Same orphan shape as writer payouts (§3), N-multiplied
  // across splits. Earlier the whole flow ran inside one transaction with
  // Stripe transfers issued mid-loop; any later throw rolled back the split
  // rows while N transfers stayed live. Now:
  //
  //   1. reservePublicationPayout (Txn 1) — insert publication_payouts row as
  //      'pending', claim read_events (publication_payout_id, migration 168's
  //      dedicated column — never writer_payout_id, the individual cycle's) +
  //      publication subscription earnings (subscription_events.publication_payout_id, §1.3)
  //      under it so another cycle can't re-count them, compute splits from
  //      exactly the claimed sets, insert all splits as 'pending', mark
  //      flat-fee shares as paid_out.
  //   2. processPublicationSplits — per-split Stripe call with stable
  //      idempotencyKey=`pub-split-${payoutId}-${split.id}`, each split
  //      status update in its own small transaction. Stripe throw flips only
  //      that split to 'failed'; other splits are unaffected.
  //   3. finalisePublicationPayout (Txn 2) — advance reserved reads to
  //      writer_paid and flip the payout row to 'initiated'.
  //
  // Crashes between steps → resumePendingPublicationPayouts on next cycle
  // retries only the splits still in 'pending' (initiated/failed splits are
  // skipped), then finalises.
  //
  // Subsumes §33: the earlier dead "mark completed" block at the end of
  // initiatePublicationPayout is replaced by finalisePublicationPayout's
  // deterministic status flip.
  // ---------------------------------------------------------------------------

  private async initiatePublicationPayout(
    publicationId: string,
    _grossPence: number,
    feeBps: number,
    payoutMaxSlices: number,
  ): Promise<number | null> {
    const reserved = await this.reservePublicationPayout(
      publicationId,
      feeBps,
      payoutMaxSlices,
    )
    if (!reserved) return null

    const totalTransferred = await this.processPublicationSplits(reserved.payoutId)
    await this.finalisePublicationPayout(reserved.payoutId, publicationId)

    logger.info(
      { payoutId: reserved.payoutId, publicationId, totalTransferred },
      'Publication payout initiated',
    )
    return totalTransferred
  }

  // Txn 1: reserve — insert a 'pending' publication_payouts row, claim the
  // publication's unpaid reads + subscription earnings under it, compute the
  // splits from the claimed sets, insert all splits as 'pending', mark
  // flat-fee shares paid_out. Commits before any Stripe call.
  private async reservePublicationPayout(
    publicationId: string,
    feeBps: number,
    payoutMaxSlices: number,
  ): Promise<{ payoutId: string } | null> {
    return withTransaction(async (client) => {
      await client.query(
        'SELECT id FROM publications WHERE id = $1 FOR UPDATE',
        [publicationId],
      )

      // Insert the payout row first (zero totals, patched from the claimed
      // sets below) so there is an id to stamp onto the rows we claim — then
      // claim FIRST and derive every amount from exactly what was claimed
      // (RETURNING), never sum-a-subquery-then-blanket-UPDATE. The old shape
      // had the same settlement race audit F6 closed in the writer cycle: a
      // read advancing to platform_settled in a concurrent confirmSettlement
      // (which does NOT hold this publication's lock) between the sum and the
      // stamp got claimed by the unconstrained UPDATE but was absent from the
      // pre-summed pool — advanced to writer_paid while its money was never
      // distributed. Summing the claimed set closes it.
      const { rows: [payoutRow] } = await client.query<{ id: string }>(
        `INSERT INTO publication_payouts
           (publication_id, total_pool_pence, platform_fee_pence, flat_fees_paid_pence, remaining_pool_pence, status)
         VALUES ($1, 0, 0, 0, 0, 'pending')
         RETURNING id`,
        [publicationId],
      )
      const payoutId = payoutRow.id

      // Claim reads: r.publication_id, not the article's current publication —
      // the exact complement of the writer cycle's exclusion (see the
      // eligibility query's note).
      const { rows: claimedReads } = await client.query<{
        chargeable_pence: number
        tab_settlement_id: string | null
      }>(
        // tab_settlement_id rides along for §3.4: a split's net is a bps share
        // of a pool spanning many charges, so it has no single natural funding
        // charge — the pool's contributing settlements become the packer's
        // PREFERENCE SET instead.
        PUBLICATION_CLAIM_READS_SQL,
        [payoutId, publicationId],
      )
      const lockedGross = claimedReads.reduce((s, r) => s + r.chargeable_pence, 0)

      // §1.3: claim publication SUBSCRIPTION earnings (already NET) under this
      // payout — the publication twin of the writer cycle's F1 claim.
      // Collection gate (migration 146): settled_at IS NOT NULL — only earnings
      // whose reader-tab debit was actually collected (stamped by
      // confirmSettlement, or at charge time when pre-paid credit funded it).
      // Never reintroduce an ungated claim. publication_payout_id makes each
      // earning claimed exactly once; a terminal split failure keeps the claim
      // (same manual re-pay posture as the reads, §1.2).
      const { rows: claimedSubs } = await client.query<{
        amount_pence: number
        tab_settlement_id: string | null
      }>(
        `UPDATE subscription_events
         SET publication_payout_id = $1
         WHERE publication_id = $2
           AND event_type = 'subscription_earning'
           AND publication_payout_id IS NULL
           AND settled_at IS NOT NULL
         RETURNING amount_pence, tab_settlement_id`,
        [payoutId, publicationId],
      )
      const subNetPence = claimedSubs.reduce((s, r) => s + r.amount_pence, 0)

      if (claimedReads.length === 0 && claimedSubs.length === 0) {
        // Nothing to distribute — claimed by a pending payout from a prior
        // (crashed) cycle, or charged back since the eligibility scan. Nothing
        // was stamped, so drop the empty payout row and bow out.
        await client.query(`DELETE FROM publication_payouts WHERE id = $1`, [payoutId])
        logger.warn(
          { publicationId },
          'Publication has no unreserved revenue — skipping (likely claimed by a pending payout)',
        )
        return null
      }

      // --- Load per-article overrides ---
      const { rows: articleShareRows } = await client.query<{
        id: string; article_id: string; account_id: string;
        share_type: string; share_value: number; paid_out: boolean;
      }>(
        // Deterministic order (M4): when the pool is short the earlier-processed
        // shares get funded first, so the ordering is load-bearing. See the
        // constant's docblock; it is exported so the ordering test runs this
        // exact SQL.
        PUBLICATION_ARTICLE_SHARES_SQL,
        [publicationId],
      )

      const articleIds = [...new Set(articleShareRows.map(s => s.article_id))]
      const articleEarnings = new Map<string, number>()

      if (articleIds.length > 0) {
        const { rows: artRows } = await client.query<{ article_id: string; net_pence: string }>(
          // Keyed on the CLAIMED set (publication_payout_id = this payout) so
          // the override base can't drift from what the pool is distributing.
          // This subsumes the old publication_id filter: an article that joined
          // the publication after accruing personal (publication_id NULL) reads
          // never has those reads claimed here — the writer cycle pays them.
          `SELECT r.article_id,
                  COALESCE(SUM(${readNetSql('r.chargeable_pence', '$2')}), 0) AS net_pence
           FROM read_events r
           WHERE r.article_id = ANY($1)
             AND r.publication_payout_id = $3
           GROUP BY r.article_id`,
          [articleIds, feeBps, payoutId],
        )
        for (const r of artRows) {
          articleEarnings.set(r.article_id, parseInt(r.net_pence, 10))
        }
      }

      // --- Load standing shares ---
      const { rows: standingRows } = await client.query<{
        account_id: string; revenue_share_bps: number;
      }>(
        // ORDER BY: the compute clamp clips whoever comes LAST, so the order must
        // be deterministic. See the constant's docblock; exported so the ordering
        // test runs this exact SQL.
        PUBLICATION_STANDING_MEMBERS_SQL,
        [publicationId],
      )

      // Delegate allocation to the pure function so production and unit tests
      // execute the same code path.
      const articleShares: ArticleShare[] = articleShareRows.map(r => ({
        id: r.id,
        articleId: r.article_id,
        accountId: r.account_id,
        shareType: r.share_type as 'flat_fee_pence' | 'revenue_bps',
        shareValue: r.share_value,
        paidOut: r.paid_out,
      }))
      const standingMembers: StandingMember[] = standingRows.map(r => ({
        accountId: r.account_id,
        revenueShareBps: r.revenue_share_bps,
      }))

      const { platformFeePence, splits, remainingPool, flatFeesPaidPence, flatFeeShareIds } =
        computePublicationSplits(lockedGross, feeBps, articleShares, articleEarnings, standingMembers, subNetPence)

      // --- Insert all splits as pending ---
      const insertedSplits: Array<{ id: string; amountPence: number }> = []
      for (const split of splits) {
        if (split.amountPence <= 0) continue
        const { rows: [splitRow] } = await client.query<{ id: string }>(
          `INSERT INTO publication_payout_splits
             (publication_payout_id, account_id, share_bps, amount_pence, share_type, article_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           RETURNING id`,
          [payoutId, split.accountId, split.shareBps, split.amountPence,
           split.shareType, split.articleId],
        )
        insertedSplits.push({ id: splitRow.id, amountPence: split.amountPence })
      }

      // --- Funding (§3.4) — everything above this line is unchanged -----------
      // Attribution is settled: computePublicationSplits decided who gets what
      // and is not reopened. What follows only decides WHICH CHARGES pay those
      // already-decided amounts, and turns the transfer under each split into
      // one child per charge drawn on. Flag off ⇒ no children, and
      // processPublicationSplits takes the single-transfer path exactly as
      // before.
      if (allocatedFundsEnabled()) {
        await this.packPublicationSplits(client, {
          payoutId,
          publicationId,
          payoutMaxSlices,
          splits: insertedSplits,
          withheldFeePence: platformFeePence,
          settlementIds: [
            ...new Set(
              [...claimedReads, ...claimedSubs]
                .map((r) => r.tab_settlement_id)
                .filter((id): id is string => id !== null),
            ),
          ],
        })
      }

      // --- Reserve flat-fee shares under this payout ---
      if (flatFeeShareIds.length > 0) {
        await client.query(
          `UPDATE publication_article_shares SET paid_out = TRUE WHERE id = ANY($1)`,
          [flatFeeShareIds],
        )
      }

      // Patch the payout row's totals from the claimed sets. total_pool_pence
      // stays Σ gross read amounts; sub_net_pence carries the subscription leg
      // separately (the F5 chargeback prorates by read_gross ÷ (pool + sub_net),
      // so sub-derived split money is never reversed by a read chargeback).
      await client.query(
        `UPDATE publication_payouts
         SET total_pool_pence = $2, platform_fee_pence = $3,
             flat_fees_paid_pence = $4, remaining_pool_pence = $5,
             sub_net_pence = $6
         WHERE id = $1`,
        [payoutId, lockedGross, platformFeePence, flatFeesPaidPence, remainingPool, subNetPence],
      )

      logger.info(
        { payoutId, publicationId, grossPence: lockedGross, subNetPence, platformFeePence, splits: splits.length },
        'Publication payout reserved (pending Stripe transfers)',
      )

      return { payoutId }
    })
  }

  // ---------------------------------------------------------------------------
  // packPublicationSplits — the funding half of the publication Txn 1 (§3.4).
  //
  // Runs INSIDE reservePublicationPayout's transaction, after the splits are
  // inserted and before anything is written back.
  //
  // TWO THINGS MAKE THIS CYCLE DIFFERENT FROM THE WRITER ONE.
  //
  // 1. ATTRIBUTION HAS NO PER-READ DECOMPOSITION. A split is a bps share of a
  //    POOL — the pool spans many charges, and `sub_net_pence` may have no
  //    charge behind it at all — so unlike a read, a split has no natural
  //    funding charge. Rather than invent an attribution, resolve it at the
  //    funding layer: ONE UNIT PER SPLIT, whose preference is the SET of the
  //    pool's contributing settlements. The packer already takes a set
  //    (`preferredSettlementIds`), so this needs nothing of it.
  //
  // 2. THE FEE IS ALREADY WITHHELD, AND THAT IS EXACTLY WHY IT MUST BE CLAIMED.
  //    The tempting reading — the pooled fee came off when the pool was
  //    computed, so charging an application fee would take it twice — is right
  //    in its premise and wrong in its conclusion. Under allocation the FULL
  //    charge is locked, so a fee never claimed as an `application_fee_amount`
  //    never leaves allocated state at all. It is not taken twice; it is taken
  //    ZERO times, and roughly a tenth of all publication revenue would
  //    accumulate as locked allocated funds every cycle. `prorateWithheldFee`
  //    routes it out to platform balance where it already belonged, FLOORED so
  //    the remainder is dust rather than an over-draw Stripe would reject. No
  //    recipient's net changes and `computePublicationSplits` is not reopened.
  //
  // THE BUDGET IS SHARED ACROSS SPLITS, so the pack cannot be a per-split call
  // against a pristine source list — two splits would both be told the same
  // charge has room and the second transfer would be rejected. The remainders
  // are threaded by hand between calls, which is safe precisely because the
  // sources were locked once, in primary-key order, for the whole of Txn 1.
  //
  // A SPLIT IS ONE INDIVISIBLE UNIT, so it lands on a single charge or falls to
  // the residual — it is never spread across charges. For a large publication,
  // whose pool by construction spans many charges, that means a member's share
  // can exceed any single charge's remaining allocation and route to platform
  // balance. That is SAFE (it is ordinary today's behaviour) but it is not
  // segregated, and it will show up as publication-heavy residual in the §3.3d
  // metric. Splitting a divisible unit across charges is the fix if the
  // measurement demands one; it is deliberately not done here, because it would
  // reintroduce the fee-proration rounding this module exists to avoid.
  // ---------------------------------------------------------------------------
  private async packPublicationSplits(
    client: PoolClient,
    input: {
      payoutId: string
      publicationId: string
      payoutMaxSlices: number
      splits: Array<{ id: string; amountPence: number }>
      withheldFeePence: number
      settlementIds: string[]
    },
  ): Promise<void> {
    const { payoutId, publicationId, payoutMaxSlices, splits, withheldFeePence } = input
    if (splits.length === 0) return

    // Locked in one statement in primary-key order — the pack order is
    // data-dependent and must not also be the lock order, or two concurrent
    // packers take the same rows in opposite orders and deadlock.
    const sources = await lockFundingSources(client, input.settlementIds)

    // The proration denominator is what is actually being DISTRIBUTED, so a
    // split the compute clamped to zero (skipped at insert) is correctly absent
    // from it.
    const distributedPence = splits.reduce((s, sp) => s + sp.amountPence, 0)

    // Local, mutable remainders. `packUnits` does not mutate its input, so
    // without this each split would be packed against the full budget.
    const remaining = new Map(sources.map((s) => [s.settlementId, s.remainingPence]))
    const preference = sources.map((s) => s.settlementId)

    let residualPence = 0

    for (const split of splits) {
      const feePence = prorateWithheldFee(
        withheldFeePence,
        split.amountPence,
        distributedPence,
      )

      const unit: EarningUnit = {
        id: split.id,
        source: 'publication_payout_splits',
        netPence: split.amountPence,
        feePence,
        // The whole pool's charges, in the locked (primary-key) order. No one
        // of them is more "this split's" charge than another.
        preferredSettlementIds: preference,
      }

      const live: FundingSource[] = sources.map((s) => ({
        ...s,
        remainingPence: remaining.get(s.settlementId) ?? 0,
      }))

      // One unit can only ever produce one slice, so this never overflows —
      // the residual is always available as a last resort. maxSlices is passed
      // for consistency with the writer cycle rather than because it can bind.
      const { slices } = packUnits([unit], live, { maxSlices: payoutMaxSlices })

      for (const slice of slices) {
        if (slice.settlementId) {
          remaining.set(
            slice.settlementId,
            (remaining.get(slice.settlementId) ?? 0) - (slice.netPence + slice.feePence),
          )
        } else {
          residualPence += slice.netPence
        }
      }

      // The split IS the parent: its children are the transfers underneath it.
      // Nothing is stamped onto a claim row here, because the publication cycle
      // claims its reads under the PAYOUT rather than under any split.
      await insertChildren(client, 'publication_payout_splits', split.id, slices)
    }

    if (residualPence > 0) {
      logger.warn(
        {
          payoutId,
          publicationId,
          residualPence,
          distributedPence,
          sources: sources.length,
        },
        'Publication splits partly funded from platform balance — no single charge had room for the whole split',
      )
    }
  }

  // Stripe loop: for each split still in 'pending', call Stripe with a stable
  // idempotency key and flip the split to 'initiated' or 'failed'. Each split
  // is independent — one failure doesn't poison the others. KYC-incomplete
  // accounts stay pending until the next cycle retries them.
  private async processPublicationSplits(payoutId: string): Promise<number> {
    const { rows: pendingSplits } = await pool.query<{
      id: string; account_id: string; amount_pence: number;
    }>(
      `SELECT id, account_id, amount_pence
       FROM publication_payout_splits
       WHERE publication_payout_id = $1
         AND status = 'pending'
         AND amount_pence > 0
       ORDER BY id ASC`,
      [payoutId],
    )

    let totalTransferred = 0

    for (const split of pendingSplits) {
      const { rows: accRows } = await pool.query<{
        stripe_connect_id: string | null; stripe_connect_kyc_complete: boolean;
      }>(
        `SELECT stripe_connect_id, stripe_connect_kyc_complete FROM accounts WHERE id = $1`,
        [split.account_id],
      )

      const acc = accRows[0]
      if (!acc?.stripe_connect_id || !acc.stripe_connect_kyc_complete) {
        // Leave pending — next cycle will retry once KYC completes
        continue
      }

      // Capture the guard-narrowed connect id in a const so the narrowing
      // survives into the thunk closure below (control-flow narrowing of the
      // mutable `acc.stripe_connect_id` does not persist into a callback).
      const destination = acc.stripe_connect_id

      // Keyed on the DATA, not the flag (§3.4). A split reserved with
      // segregation ON must pay through its children even if an operator flips
      // the flag off mid-flight — the children exist, their draws are recorded,
      // and one aggregate transfer would double-pay against them.
      if (await hasChildren('publication_payout_splits', split.id)) {
        const paid = await this.completePublicationSplitChildren(
          payoutId,
          split.id,
          split.account_id,
          destination,
        )
        totalTransferred += paid
        continue
      }

      // Keyed on split.id, NOT account_id: computePublicationSplits can emit
      // two splits for the same account in one payout (a standing member who
      // also holds an article share), and a per-account key would make the
      // second create a param-mismatch idempotency_error — classified
      // ambiguous, re-thrown, wedging the payout's remaining legs 'pending'
      // forever (2026-07-15 audit). split.id is the row-stable key.
      const idempotencyKey = `pub-split-${payoutId}-${split.id}`
      let outcome: StripeIdempotentOutcome<Stripe.Transfer>
      try {
        outcome = await executeStripeIdempotent(
          'publication-split',
          idempotencyKey,
          () => this.stripe.transfers.create({
            amount: split.amount_pence,
            currency: 'gbp',
            destination,
            metadata: {
              platform: 'all.haus',
              publication_payout_id: payoutId,
              split_id: split.id,
              account_id: split.account_id,
            },
          }, {
            idempotencyKey,
          }),
          isTerminalTransferError,
        )
      } catch (err) {
        // Ambiguous (network/timeout/5xx): the primitive re-threw because the
        // transfer MAY exist — the split must stay 'pending' so the resume sweep
        // retries with the SAME idempotency key (which dedupes a transfer that
        // did go through); marking it 'failed' here would strand real money with
        // no ledger entry and freeze the parent at 'pending' forever. Re-throw
        // (with split context) so the caller's cycle logs the sweep-level failure.
        logger.error(
          { err, splitId: split.id, accountId: split.account_id, payoutId },
          'Publication split transfer ambiguous — left pending for the resume sweep',
        )
        throw err
      }

      if (!outcome.ok) {
        // Terminal rejection (isTerminalTransferError; 2026-07-06 audit P1 —
        // the pre-F4 catch blanket-failed every error): Stripe created NO
        // transfer — mark the split 'failed' so the parent payout surfaces it,
        // then move to the next split (the parent stays 'pending').
        logger.error(
          { err: outcome.err, splitId: split.id, accountId: split.account_id, payoutId },
          'Stripe transfer terminally rejected for publication split',
        )
        await pool.query(
          `UPDATE publication_payout_splits SET status = 'failed' WHERE id = $1`,
          [split.id],
        )
        continue
      }
      const transfer = outcome.object

      // Flip the split and post its ledger entry in ONE txn so they commit
      // together: if the flip committed but the entry didn't, the split would
      // never be re-selected (the loop only picks 'pending') and the credit
      // would be lost. Gated on the pending→completed flip for idempotency.
      // Audit F4 (2026-07-06): completion keyed off the create response — a
      // platform→connected transfer gets no transfer.paid webhook, so the split
      // reaches 'completed' the moment its transfer is created (a later reversal
      // is caught by transfer.reversed → reversePublicationSplit).
      await withTransaction(async (client) => {
        const flipped = await client.query(
          `UPDATE publication_payout_splits
             SET status = 'completed', stripe_transfer_id = $1
             WHERE id = $2 AND status = 'pending'`,
          [transfer.id, split.id],
        )
        if (flipped.rowCount! > 0) {
          // Ledger: publication-member credit — money received. +amount,
          // counterparty = platform (NULL). SUM == historic split sums.
          await recordLedger(client, {
            accountId: split.account_id,
            counterpartyId: null,
            amountPence: split.amount_pence,
            triggerType: 'publication_split',
            refTable: 'publication_payout_splits',
            refId: split.id,
          })
        }
      })
      totalTransferred += split.amount_pence
    }

    return totalTransferred
  }

  // ---------------------------------------------------------------------------
  // completePublicationSplitChildren — the segregated path for ONE split (§3.4).
  //
  // One transfer per funding charge, each completed or failed independently,
  // then the split settled once no child is left pending. Because the packing
  // committed in Txn 1, this is a REPLAY: it never re-packs, so a crash-resume
  // reproduces exactly the same transfers under exactly the same keys.
  //
  // Returns the pence actually paid, which is what the caller adds to its
  // running total — NOT the split's reserved amount. A split whose second child
  // Stripe rejected paid less than it claimed, and `completeParentIfSettled`
  // restates `amount_pence` to Σ completed children so the row, the ledger and
  // Stripe agree. That restatement is also what keeps the F5 chargeback
  // proration honest: it reverses against what was paid, not what was intended.
  // ---------------------------------------------------------------------------
  private async completePublicationSplitChildren(
    payoutId: string,
    splitId: string,
    accountId: string,
    destination: string,
  ): Promise<number> {
    const spec: ChildCycleSpec = {
      parentTable: 'publication_payout_splits',
      parentId: splitId,
      destination,
      metadata: {
        publication_payout_id: payoutId,
        split_id: splitId,
        account_id: accountId,
      },

      postLedger: async (client, child) => {
        // Publication-member credit — money received. +amount, counterparty =
        // platform (NULL). One entry PER CHILD, for its own net. The ref stays
        // the PARENT split row and must: `ledger_publication_distribution`
        // hard-filters `ref_table = 'publication_payout_splits'` and joins on
        // that table's id, so re-pointing it at the child would silently empty
        // the view — and reconcile-ledger's ledger_orphans check ends in a
        // default-deny catch-all over reversal ref_tables that halts ALL
        // payouts on an unknown one.
        await recordLedger(client, {
          accountId,
          counterpartyId: null,
          amountPence: child.net_pence,
          triggerType: 'publication_split',
          refTable: 'publication_payout_splits',
          refId: splitId,
        })
      },

      // No-ops, and not by oversight. The publication cycle claims its reads
      // under the PAYOUT, not under any split, so a split owns no claim rows to
      // advance — `finalisePublicationPayout` advances them all at once — and a
      // terminally failed split keeps its claim rather than releasing it, which
      // is the existing §1.2 posture: the split is marked failed and visible,
      // and re-pay is manual (an automatic retry would need a fresh split row,
      // since the idempotency key would otherwise dedupe to the failed
      // transfer).
      advanceUnits: async () => {},
      releaseUnits: async () => {},
    }

    const result = await executePendingChildren(this.stripe, spec)

    const completion = await withTransaction((client) =>
      completeParentIfSettled(client, 'publication_payout_splits', splitId),
    )

    logger.info(
      {
        payoutId,
        splitId,
        accountId,
        children: result,
        splitCompleted: completion.completed,
        amountPence: completion.paidPence,
      },
      'Publication split children executed',
    )

    return completion.completed ? completion.paidPence : 0
  }

  // Txn 2: advance reserved read_events to writer_paid and flip the payout
  // row to 'initiated'. Safe to call repeatedly — both UPDATEs are
  // idempotent (WHERE status='platform_settled' / no-op on already-initiated).
  private async finalisePublicationPayout(
    payoutId: string,
    publicationId: string,
  ): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(PUBLICATION_FINALISE_READS_SQL, [publicationId, payoutId])

      // Complete the parent off the create response when no split is left
      // 'pending'. The rule, and the zombie it fixes, live on the constant.
      // This is also the rule `completeParentIfSettled` already applies to the
      // payouts that carry `payout_transfers` children; it had simply never
      // been applied to this legacy parent.
      await client.query(PUBLICATION_PAYOUT_COMPLETE_SQL, [payoutId])
    })
  }

  // Resume publication_payouts stuck in 'pending' from prior runs. Retries
  // pending splits (stable idempotency keys make this safe) and finalises.
  async resumePendingPublicationPayouts(): Promise<void> {
    const { rows } = await pool.query<{ id: string; publication_id: string }>(
      `SELECT id, publication_id
       FROM publication_payouts
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    )

    if (rows.length === 0) return

    logger.info({ count: rows.length }, 'Resuming pending publication payouts')

    for (const row of rows) {
      try {
        await this.processPublicationSplits(row.id)
        await this.finalisePublicationPayout(row.id, row.publication_id)
      } catch (err) {
        logger.error(
          { err, payoutId: row.id, publicationId: row.publication_id },
          'Failed to resume pending publication payout — will retry next cycle',
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // repayFailedPublicationSplits — CONSOLIDATED-TODO §1.2, migration 167.
  //
  // A split Stripe terminally rejected at create time is marked 'failed' and, on
  // its own, stays that way forever: the member is short and nothing retries them.
  //
  // WHY IT CANNOT SIMPLY BE RETRIED IN PLACE. The idempotency key
  // `pub-split-${payoutId}-${splitId}` is row-stable on purpose — that is what
  // lets the resume sweep retry an AMBIGUOUS failure without double-paying
  // (2026-07-15 audit). Retrying the same row therefore dedupes straight back
  // onto the transfer that was rejected. A correct re-pay must mint a FRESH row,
  // whose new id yields a new key.
  //
  // WHY THE MONEY DOES NOT COME BACK BY ITSELF. The writer and tribute cycles
  // release their units child by child, so a failed parent's work is re-paid
  // under a fresh parent next cycle. A split owns no claim rows — the publication
  // cycle claims its reads under the PAYOUT, and a split is a bps share of the
  // resulting pool, with no per-read decomposition to release. So the money stays
  // claimed by a payout that has already completed. Minting a replacement against
  // that same parent is the only place the money can be paid from.
  //
  // WHAT THIS DELIBERATELY DOES NOT DO. It does not reopen attribution.
  // computePublicationSplits decided who gets what and is not re-run; the
  // replacement copies its predecessor's amount, bps, share_type and article_id
  // verbatim. Anything else would let a re-pay silently redistribute a pool.
  // ---------------------------------------------------------------------------

  /**
   * How many times a split may be minted in total (the original plus its
   * replacements) before the sweep gives up and leaves it for a human.
   *
   * A terminal rejection is a DETERMINISTIC one — `StripeInvalidRequestError`,
   * per the deliberately narrow `isTerminalTransferError` — which in practice
   * means the destination is closed, rejected or otherwise not payable. Retrying
   * that forever would call Stripe every cycle for a member who can never be
   * paid, and mint a row each time. Three attempts covers the case worth covering
   * (an account fixed between cycles) without becoming a permanent spammer.
   */
  private static readonly PUB_SPLIT_MAX_ATTEMPTS = 3

  async repayFailedPublicationSplits(): Promise<{ minted: number; exhausted: number }> {
    const { rows: candidates } = await pool.query<{
      id: string
      publication_payout_id: string
      account_id: string
      share_bps: number | null
      amount_pence: number
      share_type: string
      article_id: string | null
      attempt: number
      publication_id: string
    }>(
      PUB_SPLIT_REPAY_CANDIDATES_SQL,
    )

    if (candidates.length === 0) return { minted: 0, exhausted: 0 }

    const config = await loadConfig()
    let minted = 0
    let exhausted = 0

    for (const split of candidates) {
      if (split.attempt >= PayoutService.PUB_SPLIT_MAX_ATTEMPTS) {
        exhausted++
        logger.error(
          {
            splitId: split.id,
            payoutId: split.publication_payout_id,
            publicationId: split.publication_id,
            accountId: split.account_id,
            amountPence: split.amount_pence,
            attempt: split.attempt,
          },
          'Publication split has exhausted its re-pay attempts — needs manual intervention',
        )
        continue
      }

      // The destination is the whole reason the last attempt died, so check it
      // BEFORE burning an attempt. An account still un-onboarded is not a failed
      // re-pay, it is a re-pay that has not become possible yet — leave the row
      // alone and let a later cycle find it once KYC lands.
      const { rows: accRows } = await pool.query<{
        stripe_connect_id: string | null
        stripe_connect_kyc_complete: boolean
      }>(
        `SELECT stripe_connect_id, stripe_connect_kyc_complete FROM accounts WHERE id = $1`,
        [split.account_id],
      )
      const acc = accRows[0]
      if (!acc?.stripe_connect_id || !acc.stripe_connect_kyc_complete) continue

      try {
        await withTransaction(async (client) => {
          // Re-read under the lock. Two cycles overlapping, or a `transfer.paid`
          // arriving late, could have moved this row since the candidate scan.
          const { rows: locked } = await client.query<{
            status: string
            replaced_by_split_id: string | null
          }>(
            `SELECT status, replaced_by_split_id
               FROM publication_payout_splits
              WHERE id = $1
              FOR UPDATE`,
            [split.id],
          )
          if (
            locked.length === 0 ||
            locked[0].status !== 'failed' ||
            locked[0].replaced_by_split_id !== null
          ) {
            return
          }

          const { rows: [replacement] } = await client.query<{ id: string }>(
            PUB_SPLIT_MINT_REPLACEMENT_SQL,
            [
              split.publication_payout_id,
              split.account_id,
              split.share_bps,
              split.amount_pence,
              split.share_type,
              split.article_id,
              split.attempt + 1,
            ],
          )

          await client.query(PUB_SPLIT_SUPERSEDE_SQL, [split.id, replacement.id])

          // Fund it, if segregation is on. The predecessor's children were failed
          // by `failChild`, which DELETES their `allocated_draws` row — so the
          // budget those children reserved is already back, and packing the
          // replacement draws it afresh rather than double-drawing it. Flag off ⇒
          // no children, and processPublicationSplits takes the aggregate path,
          // exactly as it did for the original.
          if (allocatedFundsEnabled()) {
            const { rows: settlementRows } = await client.query<{ id: string }>(
              // The pool's contributing settlements, recovered the same way the
              // original pack found them: the reads and subscription earnings
              // claimed under this payout. A split has no charge of its own, so
              // the preference is the whole set (see packPublicationSplits).
              // Both arms key on publication_payout_id now (migration 168). The
              // subscription arm always did — that asymmetry was the tell that
              // the reads arm was borrowing the wrong column.
              `SELECT DISTINCT tab_settlement_id AS id
                 FROM read_events
                WHERE publication_payout_id = $1 AND tab_settlement_id IS NOT NULL
                UNION
               SELECT DISTINCT tab_settlement_id AS id
                 FROM subscription_events
                WHERE publication_payout_id = $1 AND tab_settlement_id IS NOT NULL`,
              [split.publication_payout_id],
            )

            const { rows: [payoutRow] } = await client.query<{
              platform_fee_pence: number
              total_pool_pence: number
              sub_net_pence: number
            }>(
              `SELECT platform_fee_pence, total_pool_pence, sub_net_pence
                 FROM publication_payouts WHERE id = $1`,
              [split.publication_payout_id],
            )

            await this.packPublicationSplits(client, {
              payoutId: split.publication_payout_id,
              publicationId: split.publication_id,
              payoutMaxSlices: config.payoutMaxSlices,
              splits: [{ id: replacement.id, amountPence: split.amount_pence }],
              // The fee this split's share of the pool already had withheld. The
              // original prorated the payout's whole withheld fee across every
              // split; re-deriving that same proportion here keeps the
              // replacement's application_fee identical to the one its
              // predecessor would have carried, so a re-pay moves no fee money
              // that the first attempt did not.
              withheldFeePence: prorateWithheldFee(
                payoutRow?.platform_fee_pence ?? 0,
                split.amount_pence,
                await this.distributedPenceFor(client, split.publication_payout_id),
              ),
              settlementIds: settlementRows.map((r) => r.id),
            })
          }

          await client.query(PUB_SPLIT_REOPEN_PARENT_SQL, [split.publication_payout_id])
        })

        minted++
        logger.warn(
          {
            splitId: split.id,
            payoutId: split.publication_payout_id,
            publicationId: split.publication_id,
            accountId: split.account_id,
            amountPence: split.amount_pence,
            attempt: split.attempt + 1,
          },
          'Minted a replacement publication split after a terminal rejection',
        )
      } catch (err) {
        // One member's re-pay failing must not cost the others theirs.
        logger.error(
          { err, splitId: split.id, payoutId: split.publication_payout_id },
          'Failed to mint a replacement publication split — will retry next cycle',
        )
      }
    }

    return { minted, exhausted }
  }

  /**
   * The proration denominator the original pack used: what this payout is
   * actually DISTRIBUTING. Counts every split that is or was payable — a
   * superseded 'failed' row is excluded (its replacement stands in its place),
   * so the denominator does not grow with each re-pay and shrink every
   * replacement's fee.
   */
  private async distributedPenceFor(client: PoolClient, payoutId: string): Promise<number> {
    const { rows: [row] } = await client.query<{ total: string }>(
      PUB_SPLIT_DISTRIBUTED_SQL,
      [payoutId],
    )
    return parseInt(row?.total ?? '0', 10)
  }

  // ===========================================================================
  // Tribute Payout Cycle (Upstream Edges Phase 3)
  //
  // Pays each consented inspirer the share redirected to them. Runs after the
  // writer + publication cycles (the author's carve is handled inside
  // runPayoutCycle). Dark behind TRIBUTES_ENABLED.
  //
  // Per-tribute, mirroring the writer-payout three-phase durability:
  //   1. reserveTributePayout (Txn 1) — insert 'pending' tribute_payouts row and
  //      claim the tribute's released accruals under it (tribute_payout_id), so
  //      no concurrent cycle re-counts them.
  //   2. stripe.transfers.create, idempotencyKey=`tribute-payout-${payoutId}`
  //      (stable — a retry after a crash lands on the same transfer).
  //   3. completeTributePayout (Txn 2) — flip 'initiated' + store transfer id,
  //      advance the claimed accruals released→paid, post ONE tribute_payout
  //      ledger entry (account = inspirer, counterparty = author). No mirrored
  //      debit — the author's reduced writer_payout already reflects the carve.
  //
  // A crash between 1 and 3 leaves the row 'pending'; resumePendingTributePayouts
  // (called at cycle start) re-runs 2–3 with the same stable key.
  // ===========================================================================

  async runTributePayoutCycle(): Promise<{ processed: number; totalPaidPence: number }> {
    if (!tributesEnabled()) return { processed: 0, totalPaidPence: 0 }

    // §1.2 halt gate (see runPayoutCycle).
    if (await isPayoutsHalted(pool)) {
      logger.warn('Payouts halted (ledger reconciliation mismatch) — skipping tribute payout cycle')
      return { processed: 0, totalPaidPence: 0 }
    }

    await this.resumePendingTributePayouts()

    // Eligible: a live tribute whose resolved inspirer is Connect-onboarded and
    // has released-unclaimed accruals (fresh inflow to pay out). No payout
    // threshold — the share is the inspirer's the moment it releases (the
    // author's read already cleared the £20 floor to settle). Dial A: there are
    // no child swept-returns to fold in (a live tribute never un-consents). The
    // exact amount (gross − direct-children carve) is recomputed under lock in
    // reserveTributePayout, so this only finds candidates.
    const { rows: eligible } = await pool.query<{
      tribute_id: string
      inspirer_account_id: string
      author_account_id: string
      stripe_connect_id: string
    }>(
      `WITH candidates AS (
         SELECT tribute_id FROM tribute_accruals
         WHERE state = 'released' AND tribute_payout_id IS NULL
         GROUP BY tribute_id
       )
       SELECT t.id AS tribute_id,
              t.resolved_account_id AS inspirer_account_id,
              t.author_account_id,
              insp.stripe_connect_id
       FROM candidates c
       JOIN tributes t ON t.id = c.tribute_id
       JOIN accounts insp ON insp.id = t.resolved_account_id
       WHERE t.status = 'live'
         AND insp.stripe_connect_kyc_complete = TRUE
         AND insp.stripe_connect_id IS NOT NULL`,
    )

    let processed = 0
    let totalPaidPence = 0

    for (const row of eligible) {
      try {
        const paid = await this.initiateTributePayout(
          row.tribute_id,
          row.inspirer_account_id,
          row.author_account_id,
          row.stripe_connect_id,
        )
        if (paid !== null) {
          processed++
          totalPaidPence += paid
        }
      } catch (err) {
        logger.error({ err, tributeId: row.tribute_id }, 'Tribute payout failed — continuing cycle')
      }
    }

    logger.info({ processed, totalPaidPence }, 'Tribute payout cycle complete')
    return { processed, totalPaidPence }
  }

  private async initiateTributePayout(
    tributeId: string,
    inspirerId: string,
    authorId: string,
    stripeConnectId: string,
  ): Promise<number | null> {
    const reserved = await this.reserveTributePayout(tributeId, inspirerId, authorId)
    if (!reserved) return null

    await this.completeTributePayout(
      reserved.payoutId,
      tributeId,
      inspirerId,
      authorId,
      stripeConnectId,
      reserved.amountPence,
    )
    return reserved.amountPence
  }

  // Txn 1: lock the tribute, compute its LEVEL-AWARE net, insert a 'pending'
  // tribute_payouts row, and claim the rows that net feeds on. Commits before any
  // Stripe call.
  //
  // This node N is now a co-earner exactly like the author at depth 0 — its net
  // is its gross inflow minus its DIRECT children's gross:
  //   net = Σ(N's released-unclaimed accruals)              (N's gross inflow)
  //       − Σ(N's direct children's accruals on those reads) (the onward carve)
  // The carve is scoped to the reads N is claiming this cycle (a child accrual is
  // carved exactly once — when N's accrual on that read is claimed), released|paid
  // (each child's disposition is its own leg). The ceiling guarantees children
  // take ≤90% of N's inflow, so net stays positive. N's released accruals are
  // claimed under tribute_payout_id (like the author claims reads). Dial A: there
  // is no child swept-return to fold in (a live child never un-consents).
  private async reserveTributePayout(
    tributeId: string,
    inspirerId: string,
    authorId: string,
  ): Promise<{ payoutId: string; amountPence: number } | null> {
    return withTransaction(async (client) => {
      await client.query('SELECT id FROM tributes WHERE id = $1 FOR UPDATE', [tributeId])

      const { rows: [bal] } = await client.query<{
        gross_released: string
        child_carve: string
      }>(
        `SELECT
           (SELECT COALESCE(SUM(amount_pence), 0)
              FROM tribute_accruals
             WHERE tribute_id = $1 AND state = 'released' AND tribute_payout_id IS NULL)
             AS gross_released,
           (SELECT COALESCE(SUM(ca.amount_pence), 0)
              FROM tribute_accruals ca
              JOIN tributes ct ON ct.id = ca.tribute_id
             WHERE ct.parent_tribute_id = $1
               AND ca.state IN ('released', 'paid')
               AND ca.read_event_id IN (
                 SELECT read_event_id FROM tribute_accruals
                  WHERE tribute_id = $1 AND state = 'released' AND tribute_payout_id IS NULL))
             AS child_carve`,
        [tributeId],
      )
      const childCarve = parseInt(bal.child_carve, 10)
      const amountPence = parseInt(bal.gross_released, 10) - childCarve
      if (amountPence <= 0) {
        logger.warn({ tributeId }, 'Tribute has no payable net this cycle — skipping (likely claimed by a pending payout)')
        return null
      }

      const { rows: [payoutRow] } = await client.query<{ id: string }>(
        `INSERT INTO tribute_payouts
           (tribute_id, inspirer_account_id, author_account_id, amount_pence, status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING id`,
        [tributeId, inspirerId, authorId, amountPence],
      )
      const payoutId = payoutRow.id

      // Claim N's own released accruals (its gross inflow being paid).
      await client.query(
        `UPDATE tribute_accruals
         SET tribute_payout_id = $1
         WHERE tribute_id = $2 AND state = 'released' AND tribute_payout_id IS NULL`,
        [payoutId, tributeId],
      )

      // --- Funding (§3.4) — everything above this line is unchanged ------------
      // Attribution is settled: `amountPence` is what this inspirer is owed and
      // how it was computed has not moved. What follows only decides WHICH
      // CHARGES pay it. Flag off ⇒ no children, and completeTributePayout takes
      // the single-transfer path exactly as before.
      const finalAmountPence = allocatedFundsEnabled()
        ? await this.packTributePayout(client, {
            payoutId,
            tributeId,
            childCarve,
            amountPence,
          })
        : amountPence

      await client.query(
        `UPDATE tribute_payouts SET amount_pence = $1 WHERE id = $2`,
        [finalAmountPence, payoutId],
      )

      logger.info(
        { payoutId, tributeId, amountPence: finalAmountPence },
        'Tribute payout reserved (pending Stripe transfer)',
      )
      return { payoutId, amountPence: finalAmountPence }
    })
  }

  // ---------------------------------------------------------------------------
  // packTributePayout — the funding half of Txn 1 (§3.4, the easy cycle).
  //
  // Runs INSIDE reserveTributePayout's transaction, after the claim. Each claimed
  // `tribute_accruals` row is one unit with a real preferred settlement (its
  // read's) and ZERO fee — a tribute accrual is carved out of the author's
  // already-post-fee net, so there is no second fee to claim as an
  // `application_fee_amount`. Returns the amount actually placed.
  // ---------------------------------------------------------------------------
  private async packTributePayout(
    client: PoolClient,
    input: {
      payoutId: string
      tributeId: string
      childCarve: number
      amountPence: number
    },
  ): Promise<number> {
    const { payoutId, tributeId, childCarve, amountPence } = input
    const config = await loadConfig()

    const { rows: accrualRows } = await client.query<{
      id: string
      amount_pence: string
      tab_settlement_id: string | null
    }>(
      `SELECT ta.id, ta.amount_pence, re.tab_settlement_id
         FROM tribute_accruals ta
         JOIN read_events re ON re.id = ta.read_event_id
        WHERE ta.tribute_payout_id = $1
        ORDER BY ta.id`,
      [payoutId],
    )

    const accrualUnits: EarningUnit[] = accrualRows.map((a) => ({
      id: a.id,
      source: 'tribute_accruals' as const,
      netPence: parseInt(a.amount_pence, 10),
      feePence: 0,
      preferredSettlementIds: a.tab_settlement_id ? [a.tab_settlement_id] : [],
    }))

    // This node's ONWARD carve to its direct children, apportioned across its own
    // accruals — the same treatment reserveWriterPayout gives the author's root
    // carve, and for the same reason: a naive per-accrual deduction can drive a
    // unit's net below zero, and flooring it at 0 would make Σ(units) > the
    // payable net, over-paying this inspirer with money that belongs to its
    // children. Both assertions are the caller's, per apportionCarve's contract,
    // and they turn the whole class into a rolled-back transaction.
    const { units, zeroed, carveRemaining } = apportionCarve(accrualUnits, childCarve)

    if (carveRemaining !== 0) {
      throw new Error(
        `Tribute payout carve unsatisfiable (payout=${payoutId}, tribute=${tributeId}, remaining=${carveRemaining}) — rolling back`,
      )
    }

    const unitTotal = units.reduce((s, u) => s + u.netPence, 0)
    if (unitTotal !== amountPence) {
      throw new Error(
        `Tribute payout unit sum ${unitTotal} != payable net ${amountPence} (payout=${payoutId}, tribute=${tributeId}) — rolling back`,
      )
    }

    const settlementIds = [
      ...new Set(units.flatMap((u) => u.preferredSettlementIds)),
    ]
    const sources = await lockFundingSources(client, settlementIds)

    const { slices, overflow, zeroNet } = packUnits(units, sources, {
      maxSlices: config.payoutMaxSlices,
    })

    // Overflow: un-claim, so it rolls to the next cycle. There is no tribute
    // payout threshold (the share is the inspirer's the moment it releases), so
    // unlike the writer cycle a reduced payout is simply paid — nothing to
    // re-test against a floor.
    if (overflow.length > 0) {
      await client.query(
        `UPDATE tribute_accruals SET tribute_payout_id = NULL WHERE id = ANY($1)`,
        [overflow.map((u) => u.id)],
      )
      logger.warn(
        { payoutId, tributeId, overflow: overflow.length, maxSlices: config.payoutMaxSlices },
        'Tribute payout exceeded the slice cap — overflow accruals un-claimed and rolled to the next cycle',
      )
    }

    const childIds = await insertChildren(client, 'tribute_payouts', payoutId, slices)

    for (let i = 0; i < slices.length; i++) {
      await client.query(
        `UPDATE tribute_accruals SET payout_transfer_id = $1 WHERE id = ANY($2)`,
        [childIds[i], slices[i].units.map((u) => u.id)],
      )
    }

    // A carve-zeroed accrual keeps its parent claim and gets no child: its whole
    // share went onward to this node's children, so there is nothing to transfer
    // for it, and Stripe rejects amount: 0. It advances to 'paid' at parent
    // completion along with any other childless claim row.
    if (zeroed.length > 0) {
      logger.info(
        { payoutId, tributeId, zeroed: zeroed.length },
        'Accruals fully consumed by the onward carve — claimed, but no transfer',
      )
    }

    // Same childless-claim treatment for an accrual that arrived with no net
    // (a floored-to-0p accrual): claimed, no child, never un-claimed.
    if (zeroNet.length > 0) {
      logger.info(
        { payoutId, tributeId, zeroNet: zeroNet.length },
        'Zero-net accruals — claimed, but no transfer',
      )
    }

    const placedPence = slices.reduce((s, sl) => s + sl.netPence, 0)

    // Defensive, and load-bearing: with no children `completeTributePayout` falls
    // through to the LEGACY single aggregate transfer, which would pay the full
    // claimed amount for accruals this transaction just un-claimed. Unreachable
    // while `payout_max_slices >= 1` (the first unit always opens a slice), which
    // is exactly why it is worth failing loudly if the dial is ever misconfigured.
    if (placedPence <= 0) {
      throw new Error(
        `Tribute payout placed nothing (payout=${payoutId}, tribute=${tributeId}, maxSlices=${config.payoutMaxSlices}) — rolling back`,
      )
    }

    return placedPence
  }

  // Stripe transfer (stable key) + Txn 2: flip 'pending'→'initiated', advance the
  // claimed accruals released→paid, post one tribute_payout ledger entry. A
  // throw before/within leaves the row 'pending' for resume (same key dedupes).
  private async completeTributePayout(
    payoutId: string,
    tributeId: string,
    inspirerId: string,
    authorId: string,
    stripeConnectId: string,
    amountPence: number,
  ): Promise<void> {
    // Keyed on the DATA, not the flag. A payout reserved with segregation ON must
    // complete through its children even if an operator flips the flag off
    // mid-flight — the children exist, their draws are recorded, and one
    // aggregate transfer would double-pay against them.
    if (await hasChildren('tribute_payouts', payoutId)) {
      await this.completeTributePayoutChildren(
        payoutId,
        tributeId,
        inspirerId,
        authorId,
        stripeConnectId,
      )
      return
    }

    const outcome = await executeStripeIdempotent(
      'tribute-payout',
      `tribute-payout-${payoutId}`,
      () => this.stripe.transfers.create({
        amount: amountPence,
        currency: 'gbp',
        destination: stripeConnectId,
        metadata: {
          platform: 'all.haus',
          tribute_payout_id: payoutId,
          tribute_id: tributeId,
          inspirer_account_id: inspirerId,
        },
      }, {
        idempotencyKey: `tribute-payout-${payoutId}`,
      }),
      isTerminalTransferError,
    )
    if (!outcome.ok) {
      // Same terminal-rejection gap as completeWriterPayout: a revoked-capability
      // create throws and no transfer object exists, so nothing else can ever
      // resolve the row and it sits 'pending' forever with its accruals frozen.
      // (No transfer.failed webhook was ever coming either way — audit F4,
      // measured and closed 2026-07-30.) Mark failed + release for re-pay on a
      // deterministic rejection. (Ambiguous errors never reach here — the
      // primitive re-throws them so resume retries with the stable key → never
      // double-pay.) STRIPE audit S1 follow-on.
      await this.failTributePayoutTerminal(
        payoutId,
        stripeErrorCode(outcome.err, 'transfer_rejected'),
      )
      return
    }
    const transfer = outcome.object

    await withTransaction(async (client) => {
      // Audit F4 (2026-07-06): completion keyed off the create response (see
      // completeWriterPayout) — platform→connected transfers get no transfer.paid
      // webhook, so 'initiated' was terminal-but-mislabelled. A later reversal is
      // caught by transfer.reversed (reverseTributePayout).
      const flipped = await client.query(
        `UPDATE tribute_payouts
         SET status = 'completed', completed_at = now(), stripe_transfer_id = $1
         WHERE id = $2 AND status = 'pending'`,
        [transfer.id, payoutId],
      )

      const paidAccruals = await client.query<{ amount_pence: string }>(
        `UPDATE tribute_accruals
         SET state = 'paid'
         WHERE tribute_payout_id = $1 AND state = 'released'
         RETURNING amount_pence`,
        [payoutId],
      )

      // Ledger: inspirer credit — the redirected share received (net of its own
      // onward carve). +amount, counterparty = the party whose share was
      // redirected (this node's author_account_id — the article author for a
      // root, the parent inspirer for a deeper node). Counted by
      // ledger_writer_earnings (migration 127). Gated on the pending→initiated
      // flip so resume can't post it twice.
      if (flipped.rowCount! > 0) {
        await recordLedger(client, {
          accountId: inspirerId,
          counterpartyId: authorId,
          amountPence,
          triggerType: 'tribute_payout',
          refTable: 'tribute_payouts',
          refId: payoutId,
        })

        // Ledger: the author's redirect executing (item 3 final phase). When a
        // ROOT tribute's accruals reach the inspirer's real account, the carve
        // leaves the author's earned — debit the author the FULL root gross (the
        // children's onward carve flows from the inspirer, not the author, so the
        // whole root accrual left the author here). −amount, account = article
        // author, cp = root inspirer. Counted by ledger_writer_earned, so
        // ledger_writer_earned == read_net − paid_root_carve. ROOT only:
        // parent_tribute_id IS NULL — a child carve reduces the parent inspirer's
        // onward share, never the article author's read earnings, so it is out of
        // the writer-side model (it would wrongly debit the inspirer's earned).
        // This is the single point the held share enters the ledger (guard #7).
        const { rows: parentRows } = await client.query<{ is_root: boolean }>(
          `SELECT parent_tribute_id IS NULL AS is_root FROM tributes WHERE id = $1`,
          [tributeId],
        )
        const carvePence = paidAccruals.rows.reduce(
          (s, a) => s + parseInt(a.amount_pence, 10),
          0,
        )
        if (parentRows[0]?.is_root && carvePence > 0) {
          await recordLedger(client, {
            accountId: authorId,
            counterpartyId: inspirerId,
            amountPence: -carvePence,
            triggerType: 'tribute_carve',
            refTable: 'tribute_payouts',
            refId: payoutId,
          })
        }
      }
    })

    logger.info(
      { payoutId, tributeId, inspirerId, amountPence, stripeTransferId: transfer.id },
      'Tribute payout completed',
    )
  }

  // ---------------------------------------------------------------------------
  // completeTributePayoutChildren — the segregated path (§3.4 / §3.3c).
  //
  // One transfer per funding charge, each completed or failed independently, then
  // the parent settled once no child is left pending. Because the packing
  // committed in Txn 1, this is a REPLAY: it never re-packs, so a crash-resume
  // reproduces exactly the same transfers under exactly the same keys.
  // ---------------------------------------------------------------------------
  private async completeTributePayoutChildren(
    payoutId: string,
    tributeId: string,
    inspirerId: string,
    authorId: string,
    stripeConnectId: string,
  ): Promise<void> {
    const { rows: rootRows } = await pool.query<{ is_root: boolean }>(
      `SELECT parent_tribute_id IS NULL AS is_root FROM tributes WHERE id = $1`,
      [tributeId],
    )
    const isRoot = rootRows[0]?.is_root ?? false

    const spec = this.tributeChildSpec(
      payoutId,
      tributeId,
      inspirerId,
      authorId,
      stripeConnectId,
      isRoot,
    )

    const result = await executePendingChildren(this.stripe, spec)

    const completion = await withTransaction((client) =>
      this.finaliseTributePayoutParent(client, payoutId, authorId, inspirerId, isRoot),
    )

    logger.info(
      {
        payoutId,
        tributeId,
        inspirerId,
        children: result,
        parentCompleted: completion.completed,
        amountPence: completion.paidPence,
      },
      'Tribute payout children executed',
    )
  }

  /** The tribute cycle's money semantics, handed to the shared child lifecycle. */
  private tributeChildSpec(
    payoutId: string,
    tributeId: string,
    inspirerId: string,
    authorId: string,
    stripeConnectId: string,
    isRoot: boolean,
  ): ChildCycleSpec {
    return {
      parentTable: 'tribute_payouts',
      parentId: payoutId,
      destination: stripeConnectId,
      // The webhook router dispatches on `tribute_payout_id`, so a child transfer
      // must carry it or transfer.reversed lands in reverseWriterPayout's branch.
      metadata: {
        tribute_payout_id: payoutId,
        tribute_id: tributeId,
        inspirer_account_id: inspirerId,
      },

      postLedger: async (client, child) => {
        // Inspirer credit — the redirected share received, net of this node's own
        // onward carve. +amount, counterparty = the party whose share was
        // redirected. One entry PER CHILD for its own net; the ref stays the
        // PARENT `tribute_payouts` row (see ChildCycleSpec.postLedger for why).
        await recordLedger(client, {
          accountId: inspirerId,
          counterpartyId: authorId,
          amountPence: child.net_pence,
          triggerType: 'tribute_payout',
          refTable: 'tribute_payouts',
          refId: payoutId,
        })

        if (!isRoot) return

        // The author's redirect executing, for THIS child's accruals. Debit the
        // author their GROSS (`amount_pence`), not the child's net: the onward
        // carve flows from the inspirer, not the author, so the whole accrual
        // left the author here. ROOT only — a child carve reduces the parent
        // inspirer's onward share, never the article author's read earnings.
        //
        // The predicate is deliberately the same one `advanceUnits` uses, and
        // this hook runs FIRST in that shared transaction (executePendingChildren
        // posts the ledger, then advances), so the rows are still 'released'.
        // Single-shot because the whole pair is gated on the child's
        // pending→completed flip rowCount.
        const { rows: [carveRow] } = await client.query<{ carve_pence: string }>(
          TRIBUTE_CHILD_CARVE_SQL,
          [child.id],
        )
        const carvePence = parseInt(carveRow.carve_pence, 10)
        if (carvePence > 0) {
          await recordLedger(client, {
            accountId: authorId,
            counterpartyId: inspirerId,
            amountPence: -carvePence,
            triggerType: 'tribute_carve',
            refTable: 'tribute_payouts',
            refId: payoutId,
          })
        }
      },

      advanceUnits: async (client, child) => {
        await client.query(TRIBUTE_CHILD_ADVANCE_SQL, [child.id])
      },

      releaseUnits: async (client, child) => {
        await this.releaseTributeChildRows(client, child, payoutId, authorId, inspirerId, isRoot)
      },
    }
  }

  // ---------------------------------------------------------------------------
  // releaseTributeChildRows — the per-child twin of rollbackTributePayoutRows.
  //
  // Releases EXACTLY the accruals carrying this child's id — siblings and parent
  // untouched — and keeps the parent version's two state filters, both of which
  // are load-bearing for the chargeback interaction.
  // ---------------------------------------------------------------------------
  private async releaseTributeChildRows(
    client: PoolClient,
    child: ChildRow,
    payoutId: string,
    authorId: string,
    inspirerId: string,
    isRoot: boolean,
  ): Promise<void> {
    // A claimed accrual whose READ was charged back mid-flight was ledger-
    // reversed as-if-paid by the chargeback planner, but its state stayed
    // 'released' + claimed (there is no charged-back accrual state; the marker
    // lives on read_events.state). Releasing it would let the next cycle re-claim
    // and re-pay clawed-back money — void it instead, the same disposition the
    // planner gives an unclaimed released accrual.
    const voided = await client.query<{ amount_pence: string }>(
      TRIBUTE_CHILD_VOID_SQL,
      [child.id],
    )

    // Pair the planner's premature EARNED-side reversal, exactly as
    // rollbackTributePayoutRows does at the parent grain: the as-if-paid reversal
    // posted tribute_carve_reversal (+gross, author) on the premise that this
    // payout would complete and post the forward tribute_carve (−gross). Voiding
    // here means this child's completion never runs and that forward entry never
    // posts, leaving the author's ledger_writer_earned inflated forever. Post the
    // balancing tribute_carve now — the single point the ledger learns this
    // child's carve will never execute.
    const voidedPence = voided.rows.reduce(
      (s, r) => s + parseInt(r.amount_pence, 10),
      0,
    )
    if (isRoot && voidedPence > 0) {
      await recordLedger(client, {
        accountId: authorId,
        counterpartyId: inspirerId,
        amountPence: -voidedPence,
        triggerType: 'tribute_carve',
        refTable: 'tribute_payouts',
        refId: payoutId,
      })
    }

    // The rest: unclaim so the next cycle re-pays them under a fresh child.
    // State-filtered like the parent version — never flip a terminal
    // ('paid'/'voided') accrual back to claimable.
    await client.query(TRIBUTE_CHILD_RELEASE_SQL, [child.id])
  }

  /**
   * Settle the parent once no child is pending, and advance the accruals that
   * never had a child at all — those the onward carve consumed entirely. Their
   * share went to this node's children, so they are paid in the only sense that
   * applies; leaving them 'released' would let the next cycle claim and pay them
   * a second time.
   *
   * The UPDATE's RETURNING is the single-shot gate the root carve entry needs: a
   * second call matches no rows and posts nothing. `completeParentIfSettled`
   * cannot supply that gate — it reports `completed` from the tally, not from its
   * own UPDATE's rowCount.
   */
  private async finaliseTributePayoutParent(
    client: PoolClient,
    payoutId: string,
    authorId: string,
    inspirerId: string,
    isRoot: boolean,
  ) {
    const completion = await completeParentIfSettled(client, 'tribute_payouts', payoutId)
    if (completion.completed) {
      const { rows: childless } = await client.query<{ amount_pence: string }>(
        TRIBUTE_CHILDLESS_ADVANCE_SQL,
        [payoutId],
      )
      const carvePence = childless.reduce(
        (s, r) => s + parseInt(r.amount_pence, 10),
        0,
      )
      if (isRoot && carvePence > 0) {
        await recordLedger(client, {
          accountId: authorId,
          counterpartyId: inspirerId,
          amountPence: -carvePence,
          triggerType: 'tribute_carve',
          refTable: 'tribute_payouts',
          refId: payoutId,
        })
      }
    }
    return completion
  }

  /**
   * The three facts every tribute webhook handler needs about a payout it reached
   * through a CHILD row (which carries only `parent_id`).
   */
  private async tributePayoutContext(payoutId: string): Promise<{
    inspirerId: string
    authorId: string
    isRoot: boolean
  } | null> {
    const { rows } = await pool.query<{
      inspirer_account_id: string
      author_account_id: string
      is_root: boolean
    }>(
      `SELECT tp.inspirer_account_id, tp.author_account_id,
              t.parent_tribute_id IS NULL AS is_root
         FROM tribute_payouts tp
         JOIN tributes t ON t.id = tp.tribute_id
        WHERE tp.id = $1`,
      [payoutId],
    )
    if (rows.length === 0) return null
    return {
      inspirerId: rows[0].inspirer_account_id,
      authorId: rows[0].author_account_id,
      isRoot: rows[0].is_root,
    }
  }

  // Resume tribute_payouts stuck in 'pending' from prior runs. Safe to call
  // repeatedly — the stable idempotency key dedupes the Stripe transfer.
  async resumePendingTributePayouts(): Promise<void> {
    const { rows } = await pool.query<{
      id: string
      tribute_id: string
      inspirer_account_id: string
      author_account_id: string
      amount_pence: number
    }>(
      `SELECT id, tribute_id, inspirer_account_id, author_account_id, amount_pence
       FROM tribute_payouts
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    )

    if (rows.length === 0) return

    logger.info({ count: rows.length }, 'Resuming pending tribute payouts')

    for (const row of rows) {
      try {
        const { rows: accRows } = await pool.query<{
          stripe_connect_id: string | null
          stripe_connect_kyc_complete: boolean
        }>(
          `SELECT stripe_connect_id, stripe_connect_kyc_complete FROM accounts WHERE id = $1`,
          [row.inspirer_account_id],
        )
        const acc = accRows[0]
        if (!acc?.stripe_connect_id || !acc.stripe_connect_kyc_complete) {
          logger.warn(
            { tributePayoutId: row.id },
            'Cannot resume tribute payout — inspirer no longer onboarded; leaving pending',
          )
          continue
        }
        await this.completeTributePayout(
          row.id,
          row.tribute_id,
          row.inspirer_account_id,
          row.author_account_id,
          acc.stripe_connect_id,
          row.amount_pence,
        )
      } catch (err) {
        logger.error(
          { err, tributePayoutId: row.id },
          'Failed to resume tribute payout — will retry next cycle',
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // reverseTributePayout — Stripe webhook on transfer.reversed for a TRIBUTE
  // payout (F4). Mirrors reverseWriterPayout on the tribute leg, including the
  // PARTIAL-reversal handling (cumulative transfer.amount_reversed → post only
  // the delta under the row lock; flip 'reversed' only when fully reversed):
  // reverse the inspirer's receipt (tribute_payout_reversal), and — for a ROOT
  // tribute — restore the author's carve (tribute_carve_reversal, mirroring the
  // tribute_carve posted at completion) prorated to the SAME cumulative
  // fraction (floor(carve × reversed ÷ amount)), so a half-reversed payout
  // re-credits half the carve and a full reversal re-credits it all. Accruals
  // stay 'paid' (the reversal is a separate ledger fact, exactly as the
  // chargeback planner treats a paid accrual). A paid accrual already
  // charged_back is excluded from the carve sum, so the carve is never
  // double-reversed.
  // ---------------------------------------------------------------------------
  async reverseTributePayout(
    stripeTransferId: string,
    amountReversedPence: number | null,
  ): Promise<void> {
    const child = await findChildByTransferId(stripeTransferId)
    if (child) {
      if (child.parent_table !== 'tribute_payouts') return
      await this.reverseTributePayoutChild(child, amountReversedPence)
      return
    }

    await withTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string; tribute_id: string; inspirer_account_id: string;
        author_account_id: string; amount_pence: number;
      }>(
        `SELECT id, tribute_id, inspirer_account_id, author_account_id, amount_pence
           FROM tribute_payouts
          WHERE stripe_transfer_id = $1 AND status IN ('completed', 'reversed')
          FOR UPDATE`,
        [stripeTransferId],
      )
      if (rows.length === 0) {
        logger.warn({ stripeTransferId }, 'reverseTributePayout: no completed payout to reverse')
        return
      }
      const p = rows[0]
      const target = Math.min(amountReversedPence ?? p.amount_pence, p.amount_pence)
      const { rows: [posted] } = await client.query<{ posted: string }>(
        `SELECT COALESCE(-SUM(amount_pence), 0) AS posted
           FROM ledger_entries
          WHERE trigger_type = 'tribute_payout_reversal'
            AND ref_table = 'tribute_payouts' AND ref_id = $1`,
        [p.id],
      )
      const delta = target - parseInt(posted.posted, 10)
      if (delta <= 0) {
        logger.info({ tributePayoutId: p.id, stripeTransferId, target }, 'reverseTributePayout: already posted — no-op (redelivery)')
        return
      }
      await recordLedger(client, {
        accountId: p.inspirer_account_id,
        counterpartyId: p.author_account_id,
        amountPence: -delta,
        triggerType: 'tribute_payout_reversal',
        refTable: 'tribute_payouts',
        refId: p.id,
      })

      const { rows: rootRows } = await client.query<{ is_root: boolean }>(
        `SELECT parent_tribute_id IS NULL AS is_root FROM tributes WHERE id = $1`,
        [p.tribute_id],
      )
      if (rootRows[0]?.is_root) {
        const { rows: [carveRow] } = await client.query<{ carve_pence: string }>(
          `SELECT COALESCE(SUM(amount_pence), 0) AS carve_pence
             FROM tribute_accruals
            WHERE tribute_payout_id = $1 AND state = 'paid'`,
          [p.id],
        )
        const carvePence = parseInt(carveRow.carve_pence, 10)
        // Cumulative carve target at this reversal fraction; the delta over the
        // already-posted carve re-credit keeps redeliveries and staged partials
        // penny-consistent (floors; a charged_back accrual shrinking the sum
        // between partials clamps at 0, never claws the re-credit back).
        const carveTarget = Math.floor((carvePence * target) / p.amount_pence)
        const { rows: [carvePosted] } = await client.query<{ posted: string }>(
          `SELECT COALESCE(SUM(amount_pence), 0) AS posted
             FROM ledger_entries
            WHERE trigger_type = 'tribute_carve_reversal'
              AND ref_table = 'tribute_payouts' AND ref_id = $1`,
          [p.id],
        )
        const carveDelta = carveTarget - parseInt(carvePosted.posted, 10)
        if (carveDelta > 0) {
          await recordLedger(client, {
            accountId: p.author_account_id,
            counterpartyId: p.inspirer_account_id,
            amountPence: carveDelta,
            triggerType: 'tribute_carve_reversal',
            refTable: 'tribute_payouts',
            refId: p.id,
          })
        }
      }
      if (target >= p.amount_pence) {
        await client.query(`UPDATE tribute_payouts SET status = 'reversed' WHERE id = $1`, [p.id])
      }
      logger.warn(
        { tributePayoutId: p.id, reversedPence: delta, cumulativePence: target, fullyReversed: target >= p.amount_pence, stripeTransferId },
        'Tribute payout reversed by Stripe',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // reverseTributePayoutChild — one child of a multi-child tribute payout was
  // clawed back. Reverses THAT CHILD's net only; siblings and the parent's amount
  // are untouched.
  //
  // Idempotency is the child's own `reversed_pence` under its row lock (see
  // reverseChild) rather than the parent-level cumulative-SUM guard the legacy
  // path uses — that guard sums `tribute_payout_reversal` entries against the
  // payout row, and N children now share that ref, so it cannot tell them apart.
  //
  // The carve re-credit is prorated to the CHILD's cumulative reversal fraction
  // and derived from `reversed_pence` before and after the flip, so a redelivery
  // yields 0 and a staged partial yields the increment — the per-child twin of
  // the legacy `floor(carve × reversed ÷ amount)` arithmetic. The carve of the
  // CHILDLESS accruals (those the onward carve consumed) is deliberately NOT
  // re-credited: that share went to this node's children, whose own payouts are
  // untouched by a reversal of this transfer.
  // ---------------------------------------------------------------------------
  private async reverseTributePayoutChild(
    child: ChildRow,
    amountReversedPence: number | null,
  ): Promise<void> {
    await withTransaction(async (client) => {
      const { rows: payoutRows } = await client.query<{
        id: string
        tribute_id: string
        inspirer_account_id: string
        author_account_id: string
      }>(
        `SELECT id, tribute_id, inspirer_account_id, author_account_id
           FROM tribute_payouts WHERE id = $1 FOR UPDATE`,
        [child.parent_id],
      )
      if (payoutRows.length === 0) {
        logger.warn({ childId: child.id }, 'reverseTributePayout: child has no parent payout')
        return
      }
      const p = payoutRows[0]

      const delta = await reverseChild(client, child, amountReversedPence)
      if (delta <= 0) {
        logger.info(
          { tributePayoutId: p.id, childId: child.id },
          'reverseTributePayout: already posted — no-op (redelivery)',
        )
        return
      }

      await recordLedger(client, {
        accountId: p.inspirer_account_id,
        counterpartyId: p.author_account_id,
        amountPence: -delta,
        triggerType: 'tribute_payout_reversal',
        refTable: 'tribute_payouts',
        refId: p.id,
      })

      const { rows: rootRows } = await client.query<{ is_root: boolean }>(
        `SELECT parent_tribute_id IS NULL AS is_root FROM tributes WHERE id = $1`,
        [p.tribute_id],
      )
      if (rootRows[0]?.is_root) {
        // Read the child back under the lock reverseChild already holds: it has
        // just written the cumulative figure, so `after` is authoritative and
        // `before` is exact without a second posted-sum query.
        const { rows: [c] } = await client.query<{
          net_pence: number
          reversed_pence: number
        }>(
          `SELECT net_pence, reversed_pence FROM payout_transfers WHERE id = $1`,
          [child.id],
        )
        const { rows: [carveRow] } = await client.query<{ carve_pence: string }>(
          `SELECT COALESCE(SUM(amount_pence), 0) AS carve_pence
             FROM tribute_accruals
            WHERE payout_transfer_id = $1 AND state = 'paid'`,
          [child.id],
        )
        const carveDelta = prorateCarveReversal(
          parseInt(carveRow.carve_pence, 10),
          c.net_pence,
          c.reversed_pence - delta,
          c.reversed_pence,
        )
        if (carveDelta > 0) {
          await recordLedger(client, {
            accountId: p.author_account_id,
            counterpartyId: p.inspirer_account_id,
            amountPence: carveDelta,
            triggerType: 'tribute_carve_reversal',
            refTable: 'tribute_payouts',
            refId: p.id,
          })
        }
      }

      // The parent is 'reversed' only when nothing of it is left standing —
      // and a PENDING sibling is still standing (§0o.3; see the constant).
      const { rows: [tally] } = await client.query<{ outstanding: string }>(
        REVERSAL_OUTSTANDING_SQL,
        [p.id, 'tribute_payouts'],
      )
      if (parseInt(tally.outstanding, 10) <= 0) {
        await client.query(
          `UPDATE tribute_payouts SET status = 'reversed' WHERE id = $1`,
          [p.id],
        )
      }

      logger.warn(
        {
          tributePayoutId: p.id,
          childId: child.id,
          reversedPence: delta,
          stripeTransferId: child.stripe_transfer_id,
        },
        'Tribute payout child reversed by Stripe',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // rollbackTributePayoutRows — release everything a tribute_payout claimed: the
  // node's own released accruals back to 'released' (unclaimed). (Dial A: there
  // is no child swept-return leg to roll back.) Called by
  // failTributePayoutTerminal (terminal create rejection); the second caller,
  // handleFailedTributePayout, went with the transfer.failed handler (audit F4,
  // 2026-07-30). Caller owns the transaction and the tribute_payouts status
  // flip.
  // ---------------------------------------------------------------------------
  private async rollbackTributePayoutRows(
    client: PoolClient,
    payoutId: string,
  ): Promise<void> {
    // A claimed accrual whose READ was charged back mid-flight was ledger-
    // reversed as-if-paid by the chargeback planner (chargeback.ts: claimed &&
    // released ⇒ terminal 'paid'), but its state stayed 'released' + claimed —
    // there is no charged-back accrual state, the marker lives on
    // read_events.state. Releasing it here would let the next cycle re-claim
    // and re-pay clawed-back money; void it instead (terminal, unclaimable —
    // same disposition the planner gives an UNCLAIMED released accrual).
    // State-filtered (the comment's own premise, made explicit): the
    // <>'completed' guard upstream admits a 'reversed' payout, whose accruals
    // are 'paid' and must stay so — reverseTributePayout's carve sum and the
    // A9/A10 pairing both key on state = 'paid'.
    const voided = await client.query<{ amount_pence: string }>(
      `UPDATE tribute_accruals ta
          SET state = 'voided', tribute_payout_id = NULL
         FROM read_events re
        WHERE ta.tribute_payout_id = $1
          AND ta.state = 'released'
          AND re.id = ta.read_event_id
          AND re.state = 'charged_back'
        RETURNING ta.amount_pence`,
      [payoutId],
    )
    // Pair the planner's premature EARNED-side reversal. The as-if-paid
    // reversal posted tribute_carve_reversal (+root gross, author) on the
    // premise that this payout would complete and post the forward
    // tribute_carve (−root gross). Voiding here means completion never runs
    // and the forward entry never posts — leaving the reversal unpaired and
    // the author's ledger_writer_earned inflated by +root_gross FOREVER (the
    // read was fully clawed back; the author's correct earned delta is 0).
    // Post the balancing tribute_carve now, at the single point the ledger
    // learns the payout will never execute the carve. ROOT only, mirroring
    // both the forward entry and the planner's reversal (child carves never
    // touch the article author's earned). The PAID side (the unpaired
    // tribute_payout_reversal on the inspirer) is deliberately left: it is
    // the documented M3 "over-reports the platform's loss" residual, excluded
    // by reconcile-ledger A10a/A10b on failed payouts.
    const voidedPence = voided.rows.reduce(
      (s, r) => s + parseInt(r.amount_pence, 10),
      0,
    )
    if (voidedPence > 0) {
      const { rows: payoutRows } = await client.query<{
        inspirer_account_id: string
        author_account_id: string
        is_root: boolean
      }>(
        `SELECT tp.inspirer_account_id, tp.author_account_id,
                t.parent_tribute_id IS NULL AS is_root
           FROM tribute_payouts tp
           JOIN tributes t ON t.id = tp.tribute_id
          WHERE tp.id = $1`,
        [payoutId],
      )
      const payout = payoutRows[0]
      if (payout?.is_root) {
        await recordLedger(client, {
          accountId: payout.author_account_id,
          counterpartyId: payout.inspirer_account_id,
          amountPence: -voidedPence,
          triggerType: 'tribute_carve',
          refTable: 'tribute_payouts',
          refId: payoutId,
        })
      }
    }
    // The rest — the node's own accruals this payout advanced (released →
    // paid): roll back to 'released' and unclaim so the next cycle re-pays.
    // State-filtered like the writer-read rollback: never flip a terminal
    // ('paid'/'voided') accrual back to claimable.
    await client.query(
      `UPDATE tribute_accruals
          SET state = 'released', tribute_payout_id = NULL
        WHERE tribute_payout_id = $1
          AND state = 'released'`,
      [payoutId],
    )
  }

  // ---------------------------------------------------------------------------
  // failTributePayoutTerminal — a tribute transfer was rejected at create time
  // (no transfer object, no transfer.failed webhook). Flip the pending row to
  // 'failed' and release its claimed accruals for re-pay. Guarded on 'pending'.
  // ---------------------------------------------------------------------------
  private async failTributePayoutTerminal(
    payoutId: string,
    reason: string,
  ): Promise<void> {
    await withTransaction(async (client) => {
      const flipped = await client.query(
        `UPDATE tribute_payouts
         SET status = 'failed',
             failed_reason = COALESCE(failed_reason, $1),
             completed_at = NULL
         WHERE id = $2 AND status = 'pending'`,
        [reason, payoutId],
      )
      if (flipped.rowCount === 0) return
      await this.rollbackTributePayoutRows(client, payoutId)
    })

    logger.warn(
      { tributePayoutId: payoutId, reason },
      'Tribute payout transfer rejected by Stripe (no transfer created) — marked failed, accruals released for re-pay',
    )
  }

  // ---------------------------------------------------------------------------
  // reversePublicationSplit — Stripe webhook on transfer.reversed for a
  // PUBLICATION split (F4). A single completed split's funds were clawed back.
  // Mark that split 'reversed' and reverse the recipient's receipt via
  // writer_payout_reversal (the same trigger F5 uses for split-recipient
  // chargebacks — ledger_writer_earnings sums both publication_split (+) and
  // writer_payout_reversal (−) per account, so they net). The parent payout row
  // is left 'completed' (one split reversing does not undo the whole payout).
  // Idempotent on status='completed'.
  // ---------------------------------------------------------------------------
  async reversePublicationSplit(
    stripeTransferId: string,
    amountReversedPence: number | null,
  ): Promise<void> {
    const child = await findChildByTransferId(stripeTransferId)
    if (child) {
      if (child.parent_table !== 'publication_payout_splits') return
      await this.reversePublicationSplitChild(child, amountReversedPence)
      return
    }

    await withTransaction(async (client) => {
      // Partial-reversal handling mirrors reverseWriterPayout: cumulative
      // transfer.amount_reversed → post only the delta over the ledger's
      // posted-so-far (this row's ref — the F5 chargeback path posts against
      // tab_settlements, so the refs never conflate); flip 'reversed' only
      // when fully reversed.
      const { rows } = await client.query<{ id: string; account_id: string; amount_pence: number }>(
        `SELECT id, account_id, amount_pence
           FROM publication_payout_splits
          WHERE stripe_transfer_id = $1 AND status IN ('completed', 'reversed')
          FOR UPDATE`,
        [stripeTransferId],
      )
      if (rows.length === 0) {
        logger.warn({ stripeTransferId }, 'reversePublicationSplit: no completed split to reverse')
        return
      }
      const s = rows[0]
      const target = Math.min(amountReversedPence ?? s.amount_pence, s.amount_pence)
      const { rows: [posted] } = await client.query<{ posted: string }>(
        `SELECT COALESCE(-SUM(amount_pence), 0) AS posted
           FROM ledger_entries
          WHERE trigger_type = 'writer_payout_reversal'
            AND ref_table = 'publication_payout_splits' AND ref_id = $1`,
        [s.id],
      )
      const delta = target - parseInt(posted.posted, 10)
      if (delta <= 0) {
        logger.info({ splitId: s.id, stripeTransferId, target }, 'reversePublicationSplit: already posted — no-op (redelivery)')
        return
      }
      await recordLedger(client, {
        accountId: s.account_id,
        counterpartyId: null,
        amountPence: -delta,
        triggerType: 'writer_payout_reversal',
        refTable: 'publication_payout_splits',
        refId: s.id,
      })
      if (target >= s.amount_pence) {
        await client.query(`UPDATE publication_payout_splits SET status = 'reversed' WHERE id = $1`, [s.id])
      }
      logger.warn(
        { splitId: s.id, accountId: s.account_id, reversedPence: delta, cumulativePence: target, fullyReversed: target >= s.amount_pence, stripeTransferId },
        'Publication split reversed by Stripe',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // reversePublicationSplitChild — one child of a multi-child split was clawed
  // back. Reverses THAT CHILD's net only; siblings and the split's restated
  // amount are untouched.
  //
  // Idempotency is the child's own `reversed_pence` under its row lock (see
  // `reverseChild`) rather than the split-level cumulative-SUM guard the legacy
  // path uses — that guard sums `writer_payout_reversal` entries against the
  // split row, and now N children share that ref, so it cannot tell them apart.
  // The ref itself stays the split, because `ledger_publication_distribution`
  // filters on it.
  // ---------------------------------------------------------------------------
  private async reversePublicationSplitChild(
    child: ChildRow,
    amountReversedPence: number | null,
  ): Promise<void> {
    await withTransaction(async (client) => {
      const { rows: splitRows } = await client.query<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM publication_payout_splits WHERE id = $1 FOR UPDATE`,
        [child.parent_id],
      )
      if (splitRows.length === 0) {
        logger.warn({ childId: child.id }, 'reversePublicationSplit: child has no parent split')
        return
      }
      const { id: splitId, account_id: accountId } = splitRows[0]

      const delta = await reverseChild(client, child, amountReversedPence)
      if (delta <= 0) {
        logger.info(
          { splitId, childId: child.id },
          'reversePublicationSplit: already posted — no-op (redelivery)',
        )
        return
      }

      // Same trigger type as the legacy path and as F5's split-recipient
      // chargeback reversals: ledger_writer_earnings sums publication_split (+)
      // and writer_payout_reversal (−) per account, so they net.
      await recordLedger(client, {
        accountId,
        counterpartyId: null,
        amountPence: -delta,
        triggerType: 'writer_payout_reversal',
        refTable: 'publication_payout_splits',
        refId: splitId,
      })

      // The split is 'reversed' only when nothing of it is left standing — a
      // split has ONE child by construction, so the pending arm is unreachable
      // here, but the rule keeps its one home (§0o.3; see the constant).
      const { rows: [tally] } = await client.query<{ outstanding: string }>(
        REVERSAL_OUTSTANDING_SQL,
        [splitId, 'publication_payout_splits'],
      )
      if (parseInt(tally.outstanding, 10) <= 0) {
        await client.query(
          `UPDATE publication_payout_splits SET status = 'reversed' WHERE id = $1`,
          [splitId],
        )
      }

      logger.warn(
        {
          splitId,
          childId: child.id,
          accountId,
          reversedPence: delta,
          stripeTransferId: child.stripe_transfer_id,
        },
        'Publication split child reversed by Stripe',
      )
    })
  }

  // ---------------------------------------------------------------------------
  // completePublicationParentBySplit — apply the parent rule after one split
  // reached a terminal state.
  //
  // "NO SPLIT PENDING", never "every split completed" — see
  // finalisePublicationPayout for why that distinction is the whole fix.
  // ---------------------------------------------------------------------------
  private async completePublicationParentBySplit(splitId: string): Promise<void> {
    // Resolve the payout, then run the ONE completion statement — rather than a
    // second variant of the predicate that could drift from it.
    const { rows } = await pool.query<{ publication_payout_id: string }>(
      `SELECT publication_payout_id FROM publication_payout_splits WHERE id = $1`,
      [splitId],
    )
    if (rows.length === 0) return
    await pool.query(PUBLICATION_PAYOUT_COMPLETE_SQL, [rows[0].publication_payout_id])
  }

  // ---------------------------------------------------------------------------
  // reconcileConnectKyc — backstop for MISSED account.updated webhooks.
  //
  // The webhook (routes/webhook.ts) is the only path that flips
  // stripe_connect_kyc_complete = TRUE, and Stripe delivers webhooks
  // at-least-once — not always-once. A dropped/never-seen account.updated
  // leaves a writer permanently un-flipped; the payout cycles then skip them
  // every run and earnings accrue forever with no error. This sweep re-reads
  // candidates straight from Stripe and applies the SAME isConnectPayable()
  // gate as the webhook.
  //
  // Candidate = an account with a Connect id, not yet KYC-complete, that is a
  // recipient of at least one unpaid item across EVERY KYC-gated payout source
  // (so we never spend an accounts.retrieve on an abandoned-onboarding £0
  // account). The three EXISTS clauses mirror the eligibility used by, in order:
  // the writer cycle's base CTE (runPayoutCycle), publication splits
  // (processPublicationSplits), and the tribute inspirer cycle
  // (runTributePayoutCycle's released candidates). Dial A: there is no swept-
  // return source. Idempotent: the UPDATE guards on `= FALSE`, so it's a no-op
  // if a concurrent webhook already won.
  // ---------------------------------------------------------------------------
  async reconcileConnectKyc(): Promise<{
    checked: number
    flipped: number
    demoted: number
  }> {
    // Candidates = any account with a Connect id and pending earnings across the
    // KYC-gated payout sources — REGARDLESS of its current kyc flag. We re-read
    // each from Stripe and apply isConnectPayable() in BOTH directions
    // (promote a missed FALSE→TRUE, demote a missed TRUE→FALSE), so a dropped
    // account.updated in either direction self-heals. Bounded to accounts with
    // money waiting (the only place a wrong flag matters) so the demotion arm
    // costs an accounts.retrieve only for writers the cycle would otherwise pay.
    // STRIPE audit S3 (previously this swept FALSE→TRUE only).
    const { rows: candidates } = await pool.query<{
      id: string
      stripe_connect_id: string
      stripe_connect_kyc_complete: boolean
    }>(
      `SELECT a.id, a.stripe_connect_id, a.stripe_connect_kyc_complete
         FROM accounts a
        WHERE a.stripe_connect_id IS NOT NULL
          AND (
            -- (1) writer read earnings. The publication_id IS NULL filter is
            -- there because the two cycles are exact complements: a publication
            -- read is the POOL's to pay, never this writer's, and since
            -- migration 168 it is claimed on publication_payout_id — so without
            -- this filter a paid publication read matches here forever.
            EXISTS (SELECT 1 FROM read_events re
                     WHERE re.writer_id = a.id
                       AND re.state = 'platform_settled'
                       AND re.publication_id IS NULL
                       AND re.writer_payout_id IS NULL)
            -- (2) publication standing-member / contributor splits
            OR EXISTS (SELECT 1 FROM publication_payout_splits ps
                        WHERE ps.account_id = a.id
                          AND ps.status = 'pending'
                          AND ps.amount_pence > 0)
            -- (3) tribute inspirer: released shares on a live tribute they resolve to
            OR EXISTS (SELECT 1 FROM tributes t
                         JOIN tribute_accruals ta ON ta.tribute_id = t.id
                        WHERE t.resolved_account_id = a.id
                          AND t.status = 'live'
                          AND ta.state = 'released'
                          AND ta.tribute_payout_id IS NULL)
          )`,
    )

    let flipped = 0
    let demoted = 0
    for (const c of candidates) {
      let account: Stripe.Account
      try {
        account = await this.stripe.accounts.retrieve(c.stripe_connect_id)
      } catch (err) {
        // 429 / transient / deleted account — log and move on; next sweep retries.
        logger.warn(
          { err, writerId: c.id, stripeConnectId: c.stripe_connect_id },
          'KYC reconcile: accounts.retrieve failed — will retry next sweep',
        )
        continue
      }

      const payable = isConnectPayable(account)

      if (payable && !c.stripe_connect_kyc_complete) {
        const { rows } = await pool.query<{ id: string }>(
          `UPDATE accounts
              SET stripe_connect_kyc_complete = TRUE, updated_at = now()
            WHERE id = $1
              AND stripe_connect_kyc_complete = FALSE
            RETURNING id`,
          [c.id],
        )
        if (rows.length > 0) {
          flipped++
          logger.info(
            { writerId: c.id, stripeConnectId: c.stripe_connect_id },
            'KYC reconcile: promoted via sweep — account.updated webhook was missed',
          )
        }
      } else if (!payable && c.stripe_connect_kyc_complete) {
        const { rows } = await pool.query<{ id: string }>(
          `UPDATE accounts
              SET stripe_connect_kyc_complete = FALSE, updated_at = now()
            WHERE id = $1
              AND stripe_connect_kyc_complete = TRUE
            RETURNING id`,
          [c.id],
        )
        if (rows.length > 0) {
          demoted++
          logger.warn(
            { writerId: c.id, stripeConnectId: c.stripe_connect_id },
            'KYC reconcile: demoted via sweep — payability lost, account.updated webhook was missed',
          )
        }
      }
    }

    if (candidates.length > 0) {
      logger.info(
        { checked: candidates.length, flipped, demoted },
        'KYC reconcile sweep complete',
      )
    }
    return { checked: candidates.length, flipped, demoted }
  }
}

export const payoutService = new PayoutService()
