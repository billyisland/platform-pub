import type Stripe from 'stripe'
import { pool, loadConfig } from '@platform-pub/shared/db/client.js'
import { allocatedFundsEnabled } from '@platform-pub/shared/lib/env.js'
import {
  createAllocationAwareStripe,
  readAllocatedBalance,
  type ChargeWithAllocatedFunds,
} from '../lib/stripe-client.js'
import logger from '../lib/logger.js'

// =============================================================================
// allocation-reconcile — the only visibility funds segregation has.
//
// Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §3.6 (divergence) and §3.3d
// (the residual metric). Two sweeps, one posture: ALERT, NEVER HALT.
//
// WHY THIS IS A SIBLING OF ledger-reconcile RATHER THAN PART OF IT. §3.6 makes
// the point and then corrects a previous revision's misreading of our own code:
// `reconcile-ledger.ts` does not halt on the reader-tab parity break alone — its
// CRITICAL_CHECKS holds five halting checks, and `ledger_orphans` ends in a
// DEFAULT-DENY catch-all that halts ALL payouts on an unrecognised reversal
// `ref_table`. Adding an allocation check to that file is one edit away from
// halting the platform's payouts because a webhook was slow.
//
// And a false halt is exactly what an allocation divergence must not cause.
// Divergence means our DRAWING BUDGET is stale, and the packer's response to a
// stale budget is already safe by construction (§3.3a): it under-draws and
// degrades to the residual, never to an over-transfer. The money is not wrong;
// our picture of Stripe's is. Similarly a large residual (§3.3d) means the money
// is right and the SEGREGATION COVERAGE is poor. Neither is `haltPayouts`'s job
// — that is reserved for the reader-tab parity break, where the money is
// provably wrong.
//
// Both sweeps are no-ops while STRIPE_ALLOCATED_FUNDS is off.
// =============================================================================

/** Divergence at or below this is rounding and timing, not a defect. */
const DIVERGENCE_TOLERANCE_PENCE = 1

/** Settlements re-read from Stripe per run. Bounds the API cost of one sweep. */
const DIVERGENCE_BATCH = 100

const RESIDUAL_WINDOW_DAYS = 30

export interface AllocationDivergence {
  settlementId: string
  stripeChargeId: string | null
  /** allocated_pence − Σ draws: what our model believes is left to draw. */
  ourRemainingPence: number
  /** What Stripe says is left on the charge right now. */
  stripeRemainingPence: number
  /** ours − Stripe. Positive = we would over-draw; negative = we under-draw. */
  deltaPence: number
}

export interface AllocationReconcileResult {
  checked: number
  divergences: AllocationDivergence[]
  residual: ResidualMetric | null
}

export interface ResidualMetric {
  windowDays: number
  totalPence: number
  residualPence: number
  residualBps: number
  thresholdBps: number
  breached: boolean
}

// -----------------------------------------------------------------------------
// §3.6 — divergence between Stripe's allocation and our drawing budget
// -----------------------------------------------------------------------------

/**
 * The candidate charges, and what our model believes is still drawable on each.
 *
 * WHICH SETTLEMENTS, AND WHY THERE IS NO WATERMARK. §3.6 warns that a watermark
 * over `allocation_synced_at` would have to round-trip at Postgres precision —
 * carried as `::text` and compared with `$1::timestamptz`, never through a JS
 * `Date`, which holds milliseconds where `timestamptz` holds microseconds. That
 * truncation always errs backwards, so the bug ships green as a duplicate rather
 * than an error (three prior instances in this repo).
 *
 * This sweep needs no watermark at all, because `syncAllocations` already
 * provides the rotation: it re-syncs oldest-first past
 * `allocation_sync_freshness_hours`, so `allocation_synced_at` cycles through
 * the whole population. Taking the MOST RECENTLY SYNCED batch therefore walks a
 * moving window over every drawable charge, while comparing only figures fresh
 * enough that a difference means something — an hours-old `allocated_pence`
 * diverging from Stripe is our staleness, not a defect. No stored position, no
 * precision to lose.
 *
 * Exported (with its row type) so the integration test executes THIS statement
 * rather than a copy: the remaining-budget arithmetic and the
 * `allocated_pence IS NOT NULL` guard are properties of the SQL, and a test
 * running its own copy could not detect a regression here at all.
 *
 * `allocation_synced_at IS NOT NULL` is REDUNDANT and stays deliberately —
 * measured, not assumed: deleting it leaves every test green, because
 * `syncAllocations` writes both columns together and the `allocated_pence` guard
 * already excludes every row it could catch. It earns its place by making the
 * `ORDER BY … DESC` unambiguous (Postgres sorts NULLs FIRST under DESC, so a
 * never-synced row would otherwise head the batch). Unreachable, so untested —
 * said out loud rather than covered by a contrived fixture.
 */
export interface DivergenceCandidate {
  id: string
  stripe_charge_id: string | null
  stripe_payment_intent_id: string
  our_remaining: string
}

export const ALLOCATION_DIVERGENCE_CANDIDATES_SQL = `
  SELECT ts.id,
         ts.stripe_charge_id,
         ts.stripe_payment_intent_id,
         ts.allocated_pence - COALESCE((
           SELECT SUM(d.gross_pence) FROM allocated_draws d
            WHERE d.settlement_id = ts.id
         ), 0) AS our_remaining
    FROM tab_settlements ts
   WHERE ts.status = 'completed'
     AND ts.allocated_pence IS NOT NULL
     AND ts.stripe_payment_intent_id IS NOT NULL
     AND ts.allocation_synced_at IS NOT NULL
   ORDER BY ts.allocation_synced_at DESC
   LIMIT $1`

/**
 * Is this difference worth waking someone for? Extracted so the tolerance is one
 * decision in one place rather than an inline `>` the reader must find.
 */
export function isDivergent(deltaPence: number): boolean {
  return Math.abs(deltaPence) > DIVERGENCE_TOLERANCE_PENCE
}

/**
 * Re-read a batch of charges from Stripe and diff their remaining allocation
 * against ours. Alerts only — see the module header for why this never halts.
 */
export async function checkAllocationDivergence(
  stripe: Stripe,
): Promise<{ checked: number; divergences: AllocationDivergence[] }> {
  const { rows: candidates } = await pool.query<DivergenceCandidate>(
    ALLOCATION_DIVERGENCE_CANDIDATES_SQL,
    [DIVERGENCE_BATCH],
  )

  const divergences: AllocationDivergence[] = []
  let checked = 0

  for (const c of candidates) {
    let pi: Stripe.PaymentIntent
    try {
      pi = await stripe.paymentIntents.retrieve(c.stripe_payment_intent_id, {
        expand: ['latest_charge.allocated_funds.balance'],
      })
    } catch (err) {
      // Same posture as the sync sweep: a charge we could not read is not a
      // divergence, it is a charge we could not read. Next run retries.
      logger.warn(
        { err, settlementId: c.id },
        'Allocation reconcile: paymentIntents.retrieve failed — skipping this charge',
      )
      continue
    }
    checked++

    const charge =
      typeof pi.latest_charge === 'string'
        ? null
        : (pi.latest_charge as unknown as ChargeWithAllocatedFunds | null)
    const stripeRemainingPence = readAllocatedBalance(charge)

    // NOT `GREATEST(0, …)`. `lockFundingSources` floors the budget it hands the
    // packer because an under-draw is safe there; here the raw figure is the
    // whole point — a model that has over-drawn past zero is exactly the state
    // worth alerting on, and flooring it would hide the magnitude.
    const ourRemainingPence = parseInt(c.our_remaining, 10)
    const deltaPence = ourRemainingPence - stripeRemainingPence

    if (isDivergent(deltaPence)) {
      divergences.push({
        settlementId: c.id,
        stripeChargeId: c.stripe_charge_id,
        ourRemainingPence,
        stripeRemainingPence,
        deltaPence,
      })
    }
  }

  return { checked, divergences }
}

// -----------------------------------------------------------------------------
// §3.3d — the residual metric
// -----------------------------------------------------------------------------

/**
 * The rolling-30-day share of payout value that moved from PLATFORM BALANCE
 * rather than from a charge's allocated funds.
 *
 * A residual child is not a leak — §1.2's credit-funded earnings have no charge
 * behind them, so the residual has a STRUCTURAL floor and always will. What must
 * not happen is for it to be silent, because the same path also absorbs every
 * unit the packer could not fit, and a rising residual is how "the segregation
 * guarantee is quietly covering less and less" would look.
 *
 * Reversed children count in both numerator and denominator: the transfer did
 * happen and was funded from somewhere, and the reversal is a separate fact.
 * Failed children count in neither — nothing moved.
 */
export const RESIDUAL_SHARE_SQL = `
  SELECT COALESCE(SUM(net_pence), 0) AS total,
         COALESCE(SUM(net_pence) FILTER (WHERE funding = 'platform_balance'), 0) AS residual
    FROM payout_transfers
   WHERE status IN ('completed', 'reversed')
     AND completed_at >= now() - make_interval(days => $1)`

/**
 * The share itself, as arithmetic — so the empty-denominator rule is provable
 * without a database.
 *
 * No payouts in the window is NOT a 0% residual, it is NO MEASUREMENT. A share
 * computed off an empty denominator reads as "coverage is perfect", which is the
 * one thing it cannot mean, and it would silently satisfy the alert forever on a
 * platform whose payout cycle had stopped running.
 */
export function summariseResidual(
  totalPence: number,
  residualPence: number,
  thresholdBps: number,
): ResidualMetric | null {
  if (totalPence <= 0) return null
  const residualBps = Math.round((residualPence * 10000) / totalPence)
  return {
    windowDays: RESIDUAL_WINDOW_DAYS,
    totalPence,
    residualPence,
    residualBps,
    thresholdBps,
    breached: residualBps > thresholdBps,
  }
}

export async function measureResidualShare(): Promise<ResidualMetric | null> {
  const config = await loadConfig()

  const { rows } = await pool.query<{ total: string; residual: string }>(
    RESIDUAL_SHARE_SQL,
    [RESIDUAL_WINDOW_DAYS],
  )

  return summariseResidual(
    parseInt(rows[0].total, 10),
    parseInt(rows[0].residual, 10),
    config.allocatedResidualAlertBps,
  )
}

// -----------------------------------------------------------------------------
// The sweep
// -----------------------------------------------------------------------------

export async function runAllocationReconcile(): Promise<AllocationReconcileResult> {
  if (!allocatedFundsEnabled()) {
    return { checked: 0, divergences: [], residual: null }
  }

  const stripe = createAllocationAwareStripe()

  const { checked, divergences } = await checkAllocationDivergence(stripe)
  const residual = await measureResidualShare()

  if (divergences.length > 0) {
    // ERROR, not FATAL: fatal is `reconcile-ledger`'s register, and it carries
    // the halt. This wants a human before the next cycle, not a stopped platform.
    logger.error(
      {
        checked,
        diverged: divergences.length,
        worstPence: divergences.reduce(
          (w, d) => (Math.abs(d.deltaPence) > Math.abs(w) ? d.deltaPence : w),
          0,
        ),
        divergences: divergences.slice(0, 20),
      },
      'ALLOCATION DIVERGENCE — our drawing budget disagrees with Stripe. Payouts are NOT halted: a stale budget makes the packer under-draw, never over-transfer. Investigate an unrecorded refund or a missed reversal webhook.',
    )
  }

  if (residual?.breached) {
    logger.error(
      { ...residual },
      'RESIDUAL SHARE ABOVE THRESHOLD — more payout value is moving from platform balance than expected, so segregation is covering less than it should. The money is not wrong; the coverage is. Check for charges with no allocation (ineligible card brands), unrecorded refunds draining budgets, or a slice cap forcing units to the residual.',
    )
  } else if (residual) {
    logger.info({ ...residual }, 'Residual share within threshold')
  }

  return { checked, divergences, residual }
}
