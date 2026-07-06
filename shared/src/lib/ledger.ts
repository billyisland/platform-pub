import type { PoolClient } from 'pg'

// =============================================================================
// ledger_entries append helper  (Architecture-audit item 3, keystone)
//
// The single funnel every money path posts through. The caller passes its
// in-flight transaction client; this helper INSERTs one ledger row inside that
// same txn, so the entry commits or rolls back atomically with the money
// mutation it records (same pattern as `enqueueRelayPublish`). A path that
// writes its money table but forgets to call this silently under-reports — so
// Phase 1's discipline is: every money-table INSERT site has an adjacent
// recordLedger() call, CI-grep enforced.
//
// The ledger is append-only (DB-enforced by the BEFORE UPDATE OR DELETE guard
// in migration 119): corrections are REVERSING entries, never edits. So this
// helper only ever inserts.
//
// amount_pence is SIGNED: (+) credits account_id, (−) debits it (money in the
// account-holder's favour vs money they owe/are charged). A balance is
// SUM(amount_pence) over an account (the Phase 2 read-model views).
//
// SIGN CONVENTION (Phase 1, the two reconciliation anchors the plan names):
//
//   • Reader tab entries mirror reading_tabs.balance_pence movements. The tab
//     is a DEBT (grows as the reader reads), so accrual / vote / pledge are
//     DEBITS (−amount, reader owes more) and a settlement is a CREDIT
//     (+settled, debt paid down via Stripe). A spend→subscription conversion
//     also credits the tab down (subscription_credit, +credit). Hence
//         reading_tabs.balance_pence == −SUM(reader tab-affecting entries).
//     A reader entry is emitted exactly when (and by the amount that) the tab
//     balance moves — so the reconciliation holds by construction. Provisional
//     reads/votes (no card, no tab movement) get NO entry until they convert.
//     EVERY tab movement needs a mirror entry or the SUM diverges — the
//     adjacency tripwire guards both + and − balance writes.
//
//   • opening_balance entries (Phase 3, migration 121) are the one-time
//     per-account backfill that aligns −SUM(reader entries) with the live
//     reading_tabs.balance_pence the ledger missed pre-Phase-1. Inert on a
//     fresh/empty DB (no tabs ⇒ no opening rows). They are reader-tab entries
//     too, so ledger_reader_balance counts them.
//
//   • Writer / publication-member entries record money RECEIVED at payout:
//     +amount (a credit, in their favour), counterparty = NULL (platform).
//     Hence SUM(payout entries) == historic writer/publication payout sums.
//
//   • Writer-side ACCRUAL entries (item 3 final phase) record money EARNED, not
//     paid: writer_accrual (+read_net) at settlement, tribute_carve (−root carve)
//     when the carve is paid to the inspirer, and the two reversals. They are a
//     DISJOINT trigger set summed by ledger_writer_earned (the earned-incl-pending
//     view) — never mixed with the paid-out ledger_writer_earnings. The held carve
//     deliberately never appears (guard #7); only paid_root_carve debits the
//     author, so ledger_writer_earned == read_net − paid_root_carve.
//
// The platform itself is never an account_id (no platform account row) — it is
// always the NULL counterparty. Platform fee / behaviour-tax is therefore
// implicit (the gap between what a reader is charged and what a writer
// receives), derived in Phase 2 from counterparty-NULL entries, not stored as
// its own account ledger.
//
// Phase 0 shipped this helper with NO callers; Phase 1 (this change) wires the
// money paths (accrual / settlement / payout / vote_charges / pledge fulfilment).
//
// SCALE HORIZON: the Phase-2 balance views (ledger_reader_balance /
// ledger_writer_earned / …) are plain SUM()-over-history aggregates on the
// append-only ledger, served by idx_ledger_entries_account_created. Correct and
// cheap now, but per-dashboard-hit cost grows linearly with an account's entry
// count forever. When it bites, the fix is a materialised running balance (or a
// periodic per-account summary row the views sum forward from) — anticipated
// here so the eventual migration is planned, not diagnosed under load.
// =============================================================================

export type LedgerTriggerType =
  | 'read_accrual'        // payment-service accrual: provisional→accrued read revenue
  | 'tab_settlement'      // reading-tab settlement (reader debit / platform fee / net-to-writers)
  | 'writer_payout'       // writer_payouts
  | 'publication_split'   // publication_payouts + publication_payout_splits
  | 'vote_charge'         // vote_charges
  | 'pledge_fulfil'       // drive pledge fulfilment (pledges → read_events)
  | 'subscription_credit' // spend→subscription conversion credits the reader's tab down
  | 'subscription_charge'  // F1: a subscription charge debits the reader's tab (−price, cp = writer/NULL). Reader-tab entry: keeps −SUM == reading_tabs.balance_pence, so the existing settlement machinery collects it (replaces the dead free_allowance decrement). Counted by ledger_reader_balance.
  | 'subscription_earning' // F1: the writer's post-fee subscription income (+net, account = writer, cp = reader). The earned-side mirror of subscription_charge for WRITER subscriptions; folded into the per-read payout base (claimed once via subscription_events.writer_payout_id). Counted by ledger_writer_earned. Publication subscriptions post NO earning entry here (their income flows through the publication pool — follow-on).
  | 'opening_balance'     // Phase-3 one-time per-account opening tab balance (backfill)
  | 'dispute_stake'       // Upstream Edges: third-party dispute stake (−amount, debits the disputant's tab)
  | 'dispute_stake_refund'// Upstream Edges: dispute stake returned on withdrawal (+amount)
  | 'tribute_payout'      // Upstream Edges Phase 3/5: inspirer's redirected share paid out (+amount, counterparty = the party whose share was redirected — the article author for a root, the parent inspirer for a chained node)
  | 'tab_settlement_reversal' // F3 reader chargeback/refund: a settled charge clawed back — mirrors the original tab_settlement (−amount, reader debt restored, counterparty = platform/NULL). Reader-tab entry: keeps −SUM == reading_tabs.balance_pence.
  | 'writer_payout_reversal'  // F3: reverses a charged-back read's already-paid author net (−amount, counterparty = NULL). Writer's earned total goes negative — the existing clawed-back-payout posture, no synchronous Stripe recovery.
  | 'tribute_payout_reversal' // F3: reverses a charged-back read's already-paid tribute share (−amount, account = inspirer, counterparty = the party whose share was redirected). Inspirer's earned total goes negative, same posture.
  | 'writer_accrual'        // Writer-side accrual (item 3 final phase): a read's writer-side net EARNED at settlement (accrued→platform_settled). +read_net, account = writer, cp = reader. The earned-side mirror of the reader's read_accrual debit; the gross−net gap is the implicit platform fee. Posted per settled read in confirmSettlement. Counted by ledger_writer_earned (NOT the paid-out ledger_writer_earnings).
  | 'writer_accrual_reversal' // Reverses a charged-back read's writer_accrual (−read_net, account = writer, cp = reader). Fires for EVERY charged-back settled read (platform_settled and writer_paid), unlike writer_payout_reversal (paid reads only) — the accrual was posted at settlement regardless.
  | 'tribute_carve'         // The author's redirect executing: a ROOT tribute accrual reaching the inspirer's real account (released→paid) debits the author's earned by the carve. −accrual.amount, account = root author, cp = root inspirer. Posted in completeTributePayout for root accruals only (parent_tribute_id IS NULL) — the held share stays OUT of the ledger until this moment (build-plan guard #7). Counted by ledger_writer_earned.
  | 'tribute_carve_reversal' // Reverses a charged-back read's already-paid root carve, restoring the author's earned (+accrual.amount, account = root author, cp = root inspirer). Pairs with tribute_payout_reversal (which backs out the inspirer's receipt) on the earned side.

export interface LedgerEntryInput {
  /** Whose ledger this movement belongs to. */
  accountId: string
  /** The other side of the movement; NULL when the counterparty is the platform. */
  counterpartyId?: string | null
  /** Signed minor units: (+) credit to accountId, (−) debit. */
  amountPence: number
  /** ISO-4217; defaults to GBP. */
  currency?: string
  /** The economic event this row records. */
  triggerType: LedgerTriggerType
  /** Originating table + row, for reconciliation back to the live record. */
  refTable: string
  refId: string
}

export interface RecordLedgerResult {
  id: string
}

export async function recordLedger(
  client: PoolClient,
  input: LedgerEntryInput,
): Promise<RecordLedgerResult> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ledger_entries (
       account_id, counterparty_id, amount_pence, currency,
       trigger_type, ref_table, ref_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.accountId,
      input.counterpartyId ?? null,
      input.amountPence,
      input.currency ?? 'GBP',
      input.triggerType,
      input.refTable,
      input.refId,
    ],
  )
  return { id: rows[0].id }
}
