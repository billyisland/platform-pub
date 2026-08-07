import { pool } from '@platform-pub/shared/db/client.js'
import { allocatedFundsEnabled } from '@platform-pub/shared/lib/env.js'
import { measureResidualShare, type ResidualMetric } from './allocation-reconcile.js'

// =============================================================================
// allocation-coverage — the CHARGE-SIDE segregation number, for the operator.
//
// Spec: docs/adr/PAYMENT-PERIMETER-ADR.md W2 ("allocation coverage becomes a
// measured number, never an adjective").
//
// WHAT THIS NUMBER IS, AND WHY IT IS NOT THE RESIDUAL. There are two segregation
// figures and they are different measurements of different things:
//
//   • COVERAGE (here) is charge-side, over `tab_settlements`: of the reader
//     money we collected, how much did Stripe hold in allocated state? An
//     unallocated charge is one where VNL really does hold Writers' money in its
//     general balance, which is the regulatory question HJ ¶7.10.4 asks.
//   • RESIDUAL (`allocation-reconcile.ts::measureResidualShare`) is payout-side,
//     over `payout_transfers`: of the money we paid out, how much moved from
//     platform balance rather than from a charge's allocation?
//
// Neither is derivable from the other — credit-funded earnings have no charge
// behind them at all (§1.2's structural residual floor), and a fully allocated
// charge can still fund a residual child when the packer cannot fit a unit. The
// panel shows both, side by side and labelled, precisely so nobody quotes one as
// the other.
//
// WHY THIS DOES NOT RIDE `runAllocationReconcile`. That sweep short-circuits on
// `allocatedFundsEnabled()` and makes Stripe API calls per charge. A metric an
// operator loads on a dashboard must do neither: it must read honestly while the
// flag is dark (that is most of its life so far), and it must never turn a page
// load into a hundred `paymentIntents.retrieve` calls. It is one indexed
// aggregate over one table.
//
// MEASURABLE ONLY POST-FLIP, AND IT SAYS SO. `syncAllocations` no-ops while
// STRIPE_ALLOCATED_FUNDS is off, so today every row's `allocated_pence` is NULL
// — an EMPTY DENOMINATOR, not low coverage. Reporting 0% there would be a lie in
// the one direction that matters, and it would read as an emergency for as long
// as the flag ships dark. See `summariseCoverage`.
//
// EXPECT A DIP FOR 30 DAYS AFTER THE FLIP, AND DO NOT "FIX" IT.
// `SYNC_ALLOCATION_CANDIDATES_SQL` carries no date floor, so on the day the flag
// goes live the sweep stamps historical pre-flip charges 0 — they carry no
// allocation and never could. Those settlements really were unsegregated, so a
// window still containing them really is below 100%. The figure is right; only
// the intuition that it should start at 100% is wrong.
//
// WHAT THIS CANNOT TELL YOU. No card brand is stored on `tab_settlements`, so an
// uncovered settlement cannot be attributed to Mastercard (or to any other
// ineligible brand) retrospectively — see `ALLOCATION_ELIGIBLE_CARD_BRANDS` in
// `lib/stripe-client.ts` for why that population exists at all, and W2 for the
// add-time gate that would end it once Stripe fixes the 500.
// =============================================================================

const COVERAGE_WINDOW_DAYS = 30

/** Charge-side coverage over the window. Null when nothing was measured. */
export interface CoverageMetric {
  windowDays: number
  /** Completed settlements in the window whose allocation we have READ. */
  measuredCount: number
  /** Gross pence charged across those settlements — the denominator. */
  measuredPence: number
  /** Pence Stripe held in allocated state across them — the numerator. */
  allocatedPence: number
  /** allocatedPence ÷ measuredPence, in basis points. */
  coverageBps: number
  /** Measured settlements carrying NO allocation (`allocated_pence = 0`). */
  unallocatedCount: number
  unallocatedPence: number
}

/**
 * Settlements in the window we have NOT read an allocation for. Reported beside
 * the metric and folded into neither side of it.
 *
 * A never-synced row is not an uncovered charge, it is a charge we have not
 * looked at — pre-flip that is every row, post-flip it is the sweep's backlog
 * and anything `paymentIntents.retrieve` kept failing on. Counting it as
 * uncovered would make the flip look like a collapse; counting it as covered
 * would be the assertion this whole item exists to stop. So it is a third
 * number, and a large one is the operator's signal that the coverage figure is
 * computed over a partial sample — the same reason W4's attribution refuses to
 * report a truncated payload as a total.
 */
export interface UnmeasuredSettlements {
  count: number
  pence: number
}

export interface AllocationCoverageReport {
  /** The operator brake. False ⇒ nothing is being allocated at all, by design. */
  allocatedFundsEnabled: boolean
  coverage: CoverageMetric | null
  unmeasured: UnmeasuredSettlements
  /** The payout-side companion. A different number — see the module header. */
  residual: ResidualMetric | null
}

/**
 * The window, split three ways by the tri-state of `allocated_pence`.
 *
 * THE TRI-STATE IS THE WHOLE CRUX (PAYMENT-PERIMETER-ADR W2). `allocated_pence`
 * NULL means "never synced"; 0 means "synced, and Stripe held nothing". They are
 * opposite facts, so the unallocated predicate is `allocation_synced_at IS NOT
 * NULL AND allocated_pence = 0` and NEVER a bare `IS NULL` — which pre-flip
 * would classify every settlement on the platform as an unsegregated charge.
 *
 * `allocation_synced_at IS NOT NULL` and `allocated_pence IS NOT NULL` are
 * equivalent in practice (`SYNC_ALLOCATION_STAMP_SQL` writes both in one
 * UPDATE, and this module writes neither). The timestamp is the gate here
 * because it is the direct statement of the thing being asked — "have we looked
 * at this charge yet" — rather than an inference from the answer's presence.
 *
 * `status = 'completed'` only: a `failed` row collected nothing, and a `pending`
 * one has no charge to allocate against yet. A LATER-reversed settlement stays
 * in — the money was collected and held, and whether it was segregated while we
 * held it is a fact the reversal does not undo.
 *
 * Exported so the DB test executes THIS statement rather than a copy: the
 * NULL-versus-0 split is a predicate only Postgres can evaluate, and a test
 * running its own copy could not detect a regression to `IS NULL` at all.
 */
export const ALLOCATION_COVERAGE_SQL = `
  SELECT COUNT(*) FILTER (WHERE allocation_synced_at IS NOT NULL)
           AS measured_count,
         COALESCE(SUM(amount_pence) FILTER (WHERE allocation_synced_at IS NOT NULL), 0)
           AS measured_pence,
         COALESCE(SUM(allocated_pence) FILTER (WHERE allocation_synced_at IS NOT NULL), 0)
           AS allocated_pence,
         COUNT(*) FILTER (WHERE allocation_synced_at IS NOT NULL AND allocated_pence = 0)
           AS unallocated_count,
         COALESCE(SUM(amount_pence) FILTER (WHERE allocation_synced_at IS NOT NULL AND allocated_pence = 0), 0)
           AS unallocated_pence,
         COUNT(*) FILTER (WHERE allocation_synced_at IS NULL)
           AS unmeasured_count,
         COALESCE(SUM(amount_pence) FILTER (WHERE allocation_synced_at IS NULL), 0)
           AS unmeasured_pence
    FROM tab_settlements
   WHERE status = 'completed'
     AND settled_at >= now() - make_interval(days => $1)`

export interface CoverageTotals {
  measuredCount: number
  measuredPence: number
  allocatedPence: number
  unallocatedCount: number
  unallocatedPence: number
}

/**
 * The share itself, as arithmetic — so the empty-denominator rule is provable
 * without a database.
 *
 * NO MEASURED SETTLEMENTS IS NOT 0% COVERAGE, IT IS NO MEASUREMENT. This is the
 * same rule `summariseResidual` carries and for a sharper reason: a fake 0%
 * asserts that none of the platform's reader money is segregated, which is the
 * most alarming thing this panel can say, and it would say it every day the
 * flag ships dark. Null here, and the caller must render the absence in words.
 *
 * The DENOMINATOR decides, never the numerator: a window with real measured
 * settlements and zero allocation across all of them IS a measurement, and a
 * bad one that must be shown.
 */
export function summariseCoverage(t: CoverageTotals): CoverageMetric | null {
  if (t.measuredPence <= 0) return null
  return {
    windowDays: COVERAGE_WINDOW_DAYS,
    measuredCount: t.measuredCount,
    measuredPence: t.measuredPence,
    allocatedPence: t.allocatedPence,
    coverageBps: Math.round((t.allocatedPence * 10000) / t.measuredPence),
    unallocatedCount: t.unallocatedCount,
    unallocatedPence: t.unallocatedPence,
  }
}

export async function measureAllocationCoverage(): Promise<AllocationCoverageReport> {
  const { rows } = await pool.query<{
    measured_count: string
    measured_pence: string
    allocated_pence: string
    unallocated_count: string
    unallocated_pence: string
    unmeasured_count: string
    unmeasured_pence: string
  }>(ALLOCATION_COVERAGE_SQL, [COVERAGE_WINDOW_DAYS])

  const r = rows[0]
  const int = (v: string) => parseInt(v, 10)

  return {
    allocatedFundsEnabled: allocatedFundsEnabled(),
    coverage: summariseCoverage({
      measuredCount: int(r.measured_count),
      measuredPence: int(r.measured_pence),
      allocatedPence: int(r.allocated_pence),
      unallocatedCount: int(r.unallocated_count),
      unallocatedPence: int(r.unallocated_pence),
    }),
    unmeasured: {
      count: int(r.unmeasured_count),
      pence: int(r.unmeasured_pence),
    },
    residual: await measureResidualShare(),
  }
}
