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
// amount_pence is SIGNED: (+) credits account_id, (−) debits it. A balance is
// SUM(amount_pence) over an account (the Phase 2 read-model views).
//
// Phase 0 ships this helper with NO callers; Phase 1 wires the money paths
// (accrual / settlement / payout / vote_charges / pledge fulfilment).
// =============================================================================

export type LedgerTriggerType =
  | 'read_accrual'        // payment-service accrual: provisional→accrued read revenue
  | 'tab_settlement'      // reading-tab settlement (reader debit / platform fee / net-to-writers)
  | 'writer_payout'       // writer_payouts
  | 'publication_split'   // publication_payouts + publication_payout_splits
  | 'vote_charge'         // vote_charges
  | 'pledge_fulfil'       // drive pledge fulfilment (pledges → read_events)

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
