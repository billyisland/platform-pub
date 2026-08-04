import Stripe from 'stripe'
import type { PoolClient } from 'pg'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { isTerminalTransferError } from '../lib/charge-errors.js'
import {
  executeStripeIdempotent,
  stripeErrorCode,
  type StripeIdempotentOutcome,
} from '../lib/stripe-idempotent.js'
import { allocatedTransferParams } from '../lib/stripe-client.js'
import {
  prorateCarveReversal,
  type FundingSource,
  type PackedSlice,
} from '../lib/allocation-packer.js'
import logger from '../lib/logger.js'

// =============================================================================
// payout-children — one packer, one execute loop, one resume sweep, three callers.
//
// Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §3.3c.
//
// Under funds segregation a payout is no longer one transfer. Allocated funds can
// only move with `source_transaction` naming the funding charge, so a payout
// becomes N children — one per charge drawn on — and the whole point of this
// module is that ONE Stripe rejection out of N must be an ordinary event rather
// than a wedged payout.
//
// The polymorphic parent (`parent_table` + `parent_id`, no FK) is deliberate.
// Three near-identical child tables is how the three payout cycles drifted apart
// in the first place; this way a fix to the lifecycle is a fix to all three.
//
// WHAT THIS MODULE DOES NOT DO. It never decides an AMOUNT. Attribution — which
// reads a writer is owed for, the per-read-then-floor net, the subscription leg,
// the tribute carve, the collection gate — stays exactly where it is, byte for
// byte. This module only ever asks "which charge pays the already-decided
// amount, and what happens when one of those transfers fails".
// =============================================================================

export type ParentTable =
  | 'writer_payouts'
  | 'publication_payout_splits'
  | 'tribute_payouts'

export interface ChildRow {
  id: string
  parent_table: ParentTable
  parent_id: string
  settlement_id: string | null
  stripe_charge_id: string | null
  funding: 'allocated' | 'platform_balance'
  net_pence: number
  fee_pence: number
  status: 'pending' | 'completed' | 'failed' | 'reversed'
  stripe_transfer_id: string | null
}

/**
 * Everything a cycle must supply for its children to be executed, completed and
 * failed. The lifecycle is shared; the money semantics are not.
 */
export interface ChildCycleSpec {
  parentTable: ParentTable
  parentId: string
  /** Stripe Connect account the transfers land in. */
  destination: string
  /** Merged into every child's transfer metadata. */
  metadata: Record<string, string>
  /**
   * Post THIS CHILD's ledger entry, inside the same transaction as its
   * `pending → completed` flip and gated on that flip's rowCount by the caller
   * of this spec (i.e. by `executePendingChildren`, not by the implementation).
   *
   * The entry's (ref_table, ref_id) must stay the PARENT row — N entries per
   * parent, which nothing forbids (`ledger_entries` has no uniqueness on the
   * ref, and `writer_accrual` already posts one per read). This is not cosmetic:
   * `ledger_publication_distribution` hard-filters
   * `ref_table = 'publication_payout_splits'` and joins on that table's id, so
   * re-pointing the ref at the child would silently empty the view — and
   * reconcile-ledger's `ledger_orphans` check ends in a default-deny catch-all
   * over reversal ref_tables, which halts ALL payouts on an unknown one.
   */
  postLedger(client: PoolClient, child: ChildRow): Promise<void>
  /**
   * Advance the claim rows this child funded (reads → writer_paid, accruals
   * released → paid). Runs in the completion transaction.
   */
  advanceUnits(client: PoolClient, child: ChildRow): Promise<void>
  /**
   * Release the claim rows this child would have funded, so the next cycle
   * re-pays them under a fresh child. Runs in the terminal-failure transaction.
   * Must reuse the cycle's existing state filters — a read a chargeback flipped
   * to `charged_back` mid-flight keeps its state and loses only its pointers.
   */
  releaseUnits(client: PoolClient, child: ChildRow): Promise<void>
}

// -----------------------------------------------------------------------------
// Reserve-side (all of this runs inside the caller's Txn 1)
// -----------------------------------------------------------------------------

/**
 * Lock every candidate funding charge and return what is still drawable on each.
 *
 * LOCK ORDERING IS PART OF THE CONTRACT. The pack order is data-dependent, so it
 * must not also be the lock order: two concurrent packers (a cycle and a resume
 * sweep, or two cycles) would take the same settlement rows in opposite orders
 * and deadlock. One statement, primary-key order, held for the whole of Txn 1.
 *
 * The remainder is DERIVED, never stored. `GREATEST(0, …)` is deliberate and is
 * NOT the clamp the money-ledger invariant bans: `allocated_draws` is a drawing
 * budget, not a ledger — it mirrors no entry and posts no movement — and the
 * clamp can only make us UNDER-draw, which degrades to the residual path and
 * never to an over-transfer. Stripe's accounting stays authoritative; the
 * reconcile sweep is what catches divergence between the two.
 */
export async function lockFundingSources(
  client: PoolClient,
  settlementIds: string[],
): Promise<FundingSource[]> {
  if (settlementIds.length === 0) return []

  await client.query(
    `SELECT id FROM tab_settlements WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
    [settlementIds],
  )

  const { rows } = await client.query<{
    id: string
    stripe_charge_id: string
    remaining_pence: string
  }>(
    `SELECT ts.id,
            ts.stripe_charge_id,
            GREATEST(0, ts.allocated_pence - COALESCE((
              SELECT SUM(d.gross_pence) FROM allocated_draws d
               WHERE d.settlement_id = ts.id
            ), 0)) AS remaining_pence
       FROM tab_settlements ts
      WHERE ts.id = ANY($1)
        AND ts.status = 'completed'
        AND ts.stripe_charge_id IS NOT NULL
        -- NULL allocated_pence means "not known to be drawable" — never assumed.
        AND ts.allocated_pence IS NOT NULL
      ORDER BY ts.id`,
    [settlementIds],
  )

  return rows
    .map((r) => ({
      settlementId: r.id,
      stripeChargeId: r.stripe_charge_id,
      remainingPence: parseInt(r.remaining_pence, 10),
    }))
    .filter((s) => s.remainingPence > 0)
}

/**
 * Insert one child per packed slice, and one `allocated_draws` row per ALLOCATED
 * child. Returns the child ids in slice order so the caller can stamp its units.
 *
 * The draw is what decrements the budget, and it is inserted in the same
 * transaction that reads the remainder under lock — which is why over-transfer
 * is structurally impossible here rather than merely tested against.
 */
export async function insertChildren(
  client: PoolClient,
  parentTable: ParentTable,
  parentId: string,
  slices: PackedSlice[],
): Promise<string[]> {
  const ids: string[] = []

  for (const slice of slices) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payout_transfers
         (parent_table, parent_id, settlement_id, stripe_charge_id,
          funding, net_pence, fee_pence, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id`,
      [
        parentTable,
        parentId,
        slice.settlementId,
        slice.stripeChargeId,
        slice.funding,
        slice.netPence,
        slice.feePence,
      ],
    )
    const childId = rows[0].id
    ids.push(childId)

    if (slice.funding === 'allocated') {
      // GROSS, not net: Stripe debits the application fee from the same
      // allocated balance as the transfer, and the two together are what "must
      // not exceed the original payment amount" bounds.
      await client.query(
        `INSERT INTO allocated_draws
           (settlement_id, kind, ref_table, ref_id, gross_pence)
         VALUES ($1, 'transfer', 'payout_transfers', $2, $3)`,
        [slice.settlementId, childId, slice.netPence + slice.feePence],
      )
    }
  }

  return ids
}

/** Does this parent own any child rows? Keyed on the DATA, not the flag. */
export async function hasChildren(
  parentTable: ParentTable,
  parentId: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM payout_transfers
      WHERE parent_table = $1 AND parent_id = $2`,
    [parentTable, parentId],
  )
  return parseInt(rows[0].n, 10) > 0
}

// -----------------------------------------------------------------------------
// Execute
// -----------------------------------------------------------------------------

export interface ExecuteResult {
  completed: number
  failed: number
  /** Σ net_pence over children that completed on THIS pass. */
  transferredPence: number
}

/**
 * Create one Stripe transfer per still-`pending` child, then complete or fail it.
 *
 * Preserves the reserve→create→confirm discipline PER CHILD:
 *
 *   • terminal rejection (`isTerminalTransferError` — deliberately narrower than
 *     the charge classifier, `StripeInvalidRequestError` only, because double-pay
 *     is the worse failure) ⇒ Stripe created NOTHING, so mark this child failed,
 *     DELETE its draw row (returning the remainder to the budget) and release
 *     exactly its units. Siblings and parent untouched.
 *   • ambiguous/transient ⇒ RE-THROW. The transfer may exist; the child must stay
 *     `pending` so the resume sweep retries with the SAME key, which dedupes a
 *     transfer that did go through. Never roll back on ambiguous, or you
 *     double-pay.
 *
 * Idempotency key `xfer-<childRowId>` — ROW-STABLE, never composed from
 * (payout, settlement). That is the 2026-07-15 publication-split lesson: a key
 * that can collide across two legitimate rows produces a param-mismatch
 * `idempotency_error`, classified ambiguous, re-thrown, wedging the payout
 * forever.
 */
export async function executePendingChildren(
  stripe: Stripe,
  spec: ChildCycleSpec,
): Promise<ExecuteResult> {
  const { rows: children } = await pool.query<ChildRow>(
    `SELECT id, parent_table, parent_id, settlement_id, stripe_charge_id,
            funding, net_pence, fee_pence, status, stripe_transfer_id
       FROM payout_transfers
      WHERE parent_table = $1 AND parent_id = $2 AND status = 'pending'
      ORDER BY id ASC`,
    [spec.parentTable, spec.parentId],
  )

  let completed = 0
  let failed = 0
  let transferredPence = 0

  for (const child of children) {
    const idempotencyKey = `xfer-${child.id}`
    let outcome: StripeIdempotentOutcome<Stripe.Transfer>
    try {
      outcome = await executeStripeIdempotent(
        'payout-child',
        idempotencyKey,
        () =>
          stripe.transfers.create(
            {
              amount: child.net_pence,
              currency: 'gbp',
              destination: spec.destination,
              // Allocated: source_transaction + an explicit application fee, so
              // the fee actually LEAVES allocated state. Residual: neither, i.e.
              // an ordinary platform-balance transfer with the fee implicit —
              // exactly today's behaviour.
              ...allocatedTransferParams(child.stripe_charge_id, child.fee_pence),
              metadata: {
                platform: 'all.haus',
                ...spec.metadata,
                payout_transfer_id: child.id,
                funding: child.funding,
              },
            } as Stripe.TransferCreateParams,
            { idempotencyKey },
          ),
        isTerminalTransferError,
      )
    } catch (err) {
      // Ambiguous: the transfer MAY exist. Leave the child 'pending' for the
      // resume sweep and re-throw with context. Marking it failed here would
      // strand real money with no ledger entry.
      logger.error(
        { err, childId: child.id, parent: spec.parentTable, parentId: spec.parentId },
        'Payout child transfer ambiguous — left pending for the resume sweep',
      )
      throw err
    }

    if (!outcome.ok) {
      await failChildTerminal(
        spec,
        child,
        stripeErrorCode(outcome.err, 'transfer_rejected'),
      )
      failed++
      continue
    }

    const transfer = outcome.object

    await withTransaction(async (client) => {
      // The guard is `status = 'pending'`, never merely `<> 'completed'`.
      // The split-level `confirmPublicationSplit` guarded only the latter, so a
      // stray `transfer.paid` could resurrect a `failed` split and even complete
      // its parent. That handler is now deleted (audit F4 closed 2026-07-30: the
      // event never fires for a platform→connected transfer), so the hole is
      // gone rather than merely un-copied — but the rule stands on its own
      // merits, and a `<> 'completed'` guard here would still be wrong.
      const flipped = await client.query(
        `UPDATE payout_transfers
            SET status = 'completed', stripe_transfer_id = $1, completed_at = now()
          WHERE id = $2 AND status = 'pending'`,
        [transfer.id, child.id],
      )
      if (flipped.rowCount! > 0) {
        // Ledger in the SAME transaction as the flip, gated on its rowCount.
        // This is processPublicationSplits' existing shape, and its comment
        // explains why: if the flip committed but the entry didn't, the child
        // would never be re-selected (the loop only picks 'pending') and the
        // credit would be lost. Posting once at PARENT completion for the
        // parent's full amount — the tempting simplification — opens a window in
        // which money has moved and the ledger is silent, and over-reports if
        // any sibling terminally fails.
        await spec.postLedger(client, child)
        await spec.advanceUnits(client, child)
      }
    })

    completed++
    transferredPence += child.net_pence
  }

  return { completed, failed, transferredPence }
}

/**
 * Flip a `pending` child to `failed` and return its allocation to the drawing
 * budget. Returns false when the flip matched nothing, which is the caller's
 * signal to do nothing further.
 *
 * The guard is `status = 'pending'`, never `<> 'completed'`: a stray or
 * duplicate webhook must not unwind a child whose transfer was created, nor
 * re-fail one already failed and released.
 *
 * The DELETE is a single statement precisely because there is one draw per
 * child — that grain is what makes releasing a failed child cheap. The caller
 * owns the transaction and the unit release.
 */
export async function failChild(
  client: PoolClient,
  childId: string,
  reason: string,
): Promise<boolean> {
  const flipped = await client.query(
    `UPDATE payout_transfers
        SET status = 'failed', failure_reason = COALESCE(failure_reason, $1)
      WHERE id = $2 AND status = 'pending'`,
    [reason, childId],
  )
  if (flipped.rowCount === 0) return false

  await client.query(
    `DELETE FROM allocated_draws
      WHERE ref_table = 'payout_transfers' AND ref_id = $1 AND kind = 'transfer'`,
    [childId],
  )
  return true
}

/**
 * A child Stripe deterministically rejected: no transfer exists and no
 * `transfer.failed` webhook will ever fire for it (it is keyed on an id that was
 * never minted), so nothing else would ever resolve this row.
 */
async function failChildTerminal(
  spec: ChildCycleSpec,
  child: ChildRow,
  reason: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const flipped = await failChild(client, child.id, reason)
    if (!flipped) return
    await spec.releaseUnits(client, child)
  })

  logger.warn(
    {
      childId: child.id,
      parent: spec.parentTable,
      parentId: spec.parentId,
      netPence: child.net_pence,
      reason,
    },
    'Payout child transfer terminally rejected — child failed, its units released for re-pay',
  )
}

// -----------------------------------------------------------------------------
// Parent completion
// -----------------------------------------------------------------------------

export interface ParentCompletion {
  completed: boolean
  /** Every child failed: the parent paid nothing and is now terminally failed. */
  failedOutright: boolean
  paidPence: number
  failedCount: number
}

/**
 * Complete the parent when NO CHILD IS LEFT `pending` — not "when every child is
 * completed".
 *
 * That distinction fixes a live latent defect this design would otherwise have
 * copied: `finalisePublicationPayout` today completes its parent only when
 * `NOT EXISTS (split WHERE status <> 'completed')`, while the resume sweep
 * retries only `pending` splits — so a single `failed` split leaves the parent
 * permanently `pending`, a zombie no sweep will ever resolve.
 *
 * The parent's `amount_pence` is RESTATED to Σ net over its completed children.
 * Ledger parity then holds by construction, since each completed child posted
 * exactly its own net. A `failed_reason` naming the failed count is recorded
 * where the parent table has the column.
 */
export async function completeParentIfSettled(
  client: PoolClient,
  parentTable: ParentTable,
  parentId: string,
): Promise<ParentCompletion> {
  const { rows: tally } = await client.query<{
    pending: string
    failed: string
    completed_net: string
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')   AS pending,
       count(*) FILTER (WHERE status = 'failed')    AS failed,
       COALESCE(SUM(net_pence) FILTER (WHERE status IN ('completed', 'reversed')), 0) AS completed_net
     FROM payout_transfers
     WHERE parent_table = $1 AND parent_id = $2`,
    [parentTable, parentId],
  )

  const pending = parseInt(tally[0].pending, 10)
  const failedCount = parseInt(tally[0].failed, 10)
  const paidPence = parseInt(tally[0].completed_net, 10)

  if (pending > 0) {
    return { completed: false, failedOutright: false, paidPence, failedCount }
  }

  const failedReason =
    failedCount > 0 ? `${failedCount} child transfer(s) failed` : null

  // A parent whose children ALL failed has paid nothing, so completing it would
  // report a payout that did not happen — but leaving it 'pending' is worse: the
  // resume sweep would revisit it every cycle, find no pending child, and never
  // resolve it. That is precisely the zombie shape this design exists to avoid,
  // so fail it terminally instead. Its units were already released child by
  // child, so the next cycle re-pays them under a fresh parent.
  if (paidPence <= 0) {
    if (parentTable === 'writer_payouts') {
      await client.query(
        `UPDATE writer_payouts
            SET status = 'failed', completed_at = NULL,
                failed_reason = COALESCE(failed_reason, $2)
          WHERE id = $1 AND status = 'pending'`,
        [parentId, failedReason ?? 'no child transfer succeeded'],
      )
    } else if (parentTable === 'tribute_payouts') {
      await client.query(
        `UPDATE tribute_payouts
            SET status = 'failed', completed_at = NULL,
                failed_reason = COALESCE(failed_reason, $2)
          WHERE id = $1 AND status = 'pending'`,
        [parentId, failedReason ?? 'no child transfer succeeded'],
      )
    } else {
      await client.query(
        `UPDATE publication_payout_splits
            SET status = 'failed'
          WHERE id = $1 AND status = 'pending'`,
        [parentId],
      )
    }
    return { completed: false, failedOutright: true, paidPence, failedCount }
  }

  // Per-table SQL because the three parents genuinely differ:
  // publication_payout_splits carries neither completed_at nor failed_reason.
  if (parentTable === 'writer_payouts') {
    await client.query(
      `UPDATE writer_payouts
          SET status = 'completed', completed_at = now(),
              amount_pence = $2,
              failed_reason = COALESCE(failed_reason, $3)
        WHERE id = $1 AND status = 'pending'`,
      [parentId, paidPence, failedReason],
    )
  } else if (parentTable === 'tribute_payouts') {
    await client.query(
      `UPDATE tribute_payouts
          SET status = 'completed', completed_at = now(),
              amount_pence = $2,
              failed_reason = COALESCE(failed_reason, $3)
        WHERE id = $1 AND status = 'pending'`,
      [parentId, paidPence, failedReason],
    )
  } else {
    await client.query(
      `UPDATE publication_payout_splits
          SET status = 'completed', amount_pence = $2
        WHERE id = $1 AND status = 'pending'`,
      [parentId, paidPence],
    )
  }

  return { completed: true, failedOutright: false, paidPence, failedCount }
}

// -----------------------------------------------------------------------------
// Webhook resolution (§3.5)
// -----------------------------------------------------------------------------

/**
 * Resolve a Stripe transfer id to its child row, if this transfer is one.
 *
 * Every transfer webhook handler must try this FIRST. With N transfers per payout,
 * `writer_payouts.stripe_transfer_id` can hold ONE id, so a `transfer.reversed`
 * for any other child finds nothing there and is silently dropped — that alone is
 * the whole argument for re-keying, and silence is precisely what makes it
 * dangerous.
 *
 * Returning null is the legacy case, not an error: a payout made before the flip
 * has no children and its id genuinely lives on the parent, so the handler falls
 * through to its existing lookup unchanged.
 */
export async function findChildByTransferId(
  stripeTransferId: string,
): Promise<ChildRow | null> {
  const { rows } = await pool.query<ChildRow>(
    `SELECT id, parent_table, parent_id, settlement_id, stripe_charge_id,
            funding, net_pence, fee_pence, status, stripe_transfer_id
       FROM payout_transfers
      WHERE stripe_transfer_id = $1`,
    [stripeTransferId],
  )
  return rows[0] ?? null
}

/**
 * Flip one child `completed → reversed` under its row lock, and record that the
 * funds returned to the ALLOCATED state (not to platform balance — that is the
 * beta's semantics, and our drawing budget must learn about it).
 *
 * Returns the pence the caller should reverse in the ledger, or 0 for a
 * redelivery. Idempotency is `payout_transfers.reversed_pence` under the row
 * lock, replacing the handlers' current guard — a cumulative SUM of reversal
 * ledger entries against the PARENT row, which cannot distinguish children now
 * that N of them share one ref.
 *
 * Partial reversals: Stripe reports the CUMULATIVE `amount_reversed`, so only the
 * delta over what is already recorded is returned; a redelivery yields 0 and a
 * staged partial yields the increment. The child flips to `reversed` only on a
 * full reversal.
 */
export async function reverseChild(
  client: PoolClient,
  child: ChildRow,
  amountReversedPence: number | null,
): Promise<number> {
  const { rows } = await client.query<{
    id: string
    net_pence: number
    fee_pence: number
    reversed_pence: number
  }>(
    `SELECT id, net_pence, fee_pence, reversed_pence FROM payout_transfers
      WHERE id = $1 AND status IN ('completed', 'reversed')
      FOR UPDATE`,
    [child.id],
  )
  if (rows.length === 0) return 0

  const net = rows[0].net_pence
  // Captured BEFORE the UPDATE below, and used instead of re-reading rows[0]:
  // against a real database the row object is a snapshot either way, but
  // depending on that is exactly what let a live-object mock read back its own
  // write here (the CLAUDE.md copies-not-live-objects corollary, met in the
  // §0o.7a fee proration).
  const prevReversed = rows[0].reversed_pence
  // A missing amount_reversed (defensive) means full; never exceed the child.
  const target = Math.min(amountReversedPence ?? net, net)
  const delta = target - prevReversed
  if (delta <= 0) return 0

  await client.query(
    `UPDATE payout_transfers SET reversed_pence = $2 WHERE id = $1`,
    [child.id, target],
  )

  // Compensating draw so the charge's remainder reflects the return. Negative
  // gross: reversed funds go back into the allocated state, so the budget grows.
  // Only for an allocated child — a residual reversal returns to platform balance
  // and touches no allocation. UPSERT on the (ref, kind) unique so a staged
  // partial reversal accumulates rather than colliding.
  //
  // PRINCIPAL PLUS THE PRORATED FEE (§0o.7a). The transfer draw was inserted at
  // GROSS (net + fee), and with `refund_application_fee=true` — which the
  // runbook mandates below — Stripe returns the fee to the allocated state too,
  // PRORATED on a partial reversal (measured, §5 probe 7b). A principal-only
  // compensating draw therefore under-counted every fee-carrying reversed
  // child's budget by the fee share, permanently (a drawn charge is never
  // re-stamped — see syncAllocations), and made it §3.6 divergence noise. The
  // fee share reuses `prorateCarveReversal`, the same cumulative-floor
  // proration the probes validated, so a staged partial accumulates drift-free.
  //
  // When reversing MANUALLY, pass refund_application_fee=true, or the fee stays
  // with the platform while the principal returns to allocation. Under this
  // accounting a flagless reversal leaves the budget OPTIMISTIC by the fee
  // share — which §3.6 flags as a positive "we would over-draw" delta, the
  // alert's exact purpose, and Stripe itself rejects an actual over-transfer
  // (§5 step 3) — strictly better than the silent permanent under-count the
  // mandated path used to produce. This belongs in the ops runbook; it is the
  // kind of thing only ever done by hand at 2am.
  //
  // AND IF THAT CALL 500s, RETRY IT — do not conclude the flag is unsupported and
  // reverse without it. Measured 2026-07-30 in the segregation sandbox: this exact
  // call returned `StripeAPIError` 500 four times inside one ~40-minute window and
  // then succeeded fifteen consecutive times, at shorter elapsed times than the
  // failures. Reported to Stripe, who closed it as a transient backend issue with
  // nothing wrong in the request shape. A timing hypothesis (the fee-refund path
  // racing allocation state still settling) was tested at 0/2/5/15/30s and refuted
  // 12/12. The trap at 2am is that reversing WITHOUT the flag succeeds cleanly and
  // silently leaves the fee behind — the failure mode this note exists to prevent.
  // Repro/isolation harness: scripts/segregation-reversal-isolate.ts.
  if (child.funding === 'allocated' && child.settlement_id) {
    const feeDelta = prorateCarveReversal(
      rows[0].fee_pence,
      net,
      prevReversed,
      target,
    )
    await client.query(
      `INSERT INTO allocated_draws
         (settlement_id, kind, ref_table, ref_id, gross_pence)
       VALUES ($1, 'reversal', 'payout_transfers', $2, $3)
       ON CONFLICT (ref_table, ref_id, kind)
       DO UPDATE SET gross_pence = allocated_draws.gross_pence + EXCLUDED.gross_pence`,
      [child.settlement_id, child.id, -(delta + feeDelta)],
    )
  }

  if (target >= net) {
    await client.query(
      `UPDATE payout_transfers SET status = 'reversed' WHERE id = $1`,
      [child.id],
    )
  }

  return delta
}
