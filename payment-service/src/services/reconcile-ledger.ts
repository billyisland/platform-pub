import { pool } from '@platform-pub/shared/db/client.js'
import logger from '../lib/logger.js'
import { haltPayouts, type Queryable } from '../lib/payout-halt.js'

// =============================================================================
// Scheduled ledger reconciliation (PAYMENTS ADR §1.2).
//
// Promotes the load-bearing "column and ledger move by the SAME signed delta"
// invariant from a comment / a manual psql script (scripts/reconcile-ledger.sql)
// to a SCHEDULED job with a DEFINED response on mismatch: alert + halt payouts.
//
// Scope — the READER-TAB side only, and that is deliberate, not partial:
//   • The invariant we halt on is `−SUM(reader ledger) == reading_tabs.balance`
//     (the clamp-bug class: the three 2026-06-20 HIGH findings were a column and
//     its mirror ledger entry drifting apart). That is a reader-tab quantity.
//   • The payout side (writer/publication/tribute earnings) is EXPECTED-nonzero
//     against its live tables (Part B2 of reconcile-ledger.sql: writer opening
//     balances were never backfilled, and pending payouts transiently diverge),
//     so it is NOT a halt trigger — a false halt there would freeze every payout
//     for a benign, known gap.
// So we halt payouts precisely when the reader-tab ledger — the source of the
// money a payout later disburses — does not reconcile.
//
// These checks mirror the "must always be empty" WHERE-clauses of
// scripts/reconcile-ledger.sql (which stays the comprehensive human-run
// superset: Part A row-level for every trigger, Part B1 reader parity, plus the
// informational/expected-nonzero B2/B3 this job intentionally omits). Each check
// SELECTs violation rows; ANY non-empty result is a mismatch.
// =============================================================================

interface Check {
  name: string
  description: string
  sql: string
}

// LIMIT bounds the alert payload; existence — not the exact count — is what
// trips the halt, so a capped sample is sufficient for the human to start from.
const SAMPLE_LIMIT = 20

const CRITICAL_CHECKS: Check[] = [
  {
    name: 'reader_balance_parity',
    description:
      'reading_tabs.balance_pence must equal −SUM(reader ledger) per account (the clamp-bug invariant, reconcile-ledger.sql B1)',
    sql: `
      SELECT COALESCE(rt.reader_id, rb.account_id)              AS account_id,
             COALESCE(rt.balance_pence, 0)                      AS tab_balance_pence,
             COALESCE(rb.balance_pence, 0)                      AS ledger_balance_pence
      FROM reading_tabs rt
      FULL OUTER JOIN ledger_reader_balance rb ON rb.account_id = rt.reader_id
      WHERE COALESCE(rt.balance_pence, 0) <> COALESCE(rb.balance_pence, 0)
      LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    name: 'read_accrual_magnitude',
    description:
      'a read_accrual / pledge_fulfil entry magnitude must equal its read_events.amount_pence (reconcile-ledger.sql A1)',
    sql: `
      SELECT le.id AS ledger_id, le.trigger_type, le.ref_id,
             le.amount_pence, re.amount_pence AS source_pence
      FROM ledger_entries le
      JOIN read_events re ON re.id = le.ref_id
      WHERE le.trigger_type IN ('read_accrual', 'pledge_fulfil')
        AND abs(le.amount_pence) <> re.amount_pence
      LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    name: 'tab_settlement_magnitude',
    description:
      'a tab_settlement entry must equal its tab_settlements.amount_pence (reconcile-ledger.sql A3)',
    sql: `
      SELECT le.id AS ledger_id, le.ref_id,
             le.amount_pence, ts.amount_pence AS source_pence
      FROM ledger_entries le
      JOIN tab_settlements ts ON ts.id = le.ref_id
      WHERE le.trigger_type = 'tab_settlement'
        AND le.amount_pence <> ts.amount_pence
      LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    name: 'dispute_stake_integrity',
    description:
      'a dispute_stake is a negative debit on the disputant (never the cited author), self-referenced by the edge (reconcile-ledger.sql A7)',
    sql: `
      SELECT le.id AS ledger_id, le.ref_id, le.amount_pence, le.account_id,
             de.disputant_account_id, de.is_by_cited_author, de.stake_ledger_entry_id
      FROM ledger_entries le
      JOIN dispute_edges de ON de.id = le.ref_id
      WHERE le.trigger_type = 'dispute_stake'
        AND (le.account_id <> de.disputant_account_id
             OR le.amount_pence >= 0
             OR de.is_by_cited_author
             OR de.stake_ledger_entry_id IS DISTINCT FROM le.id)
      LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    name: 'ledger_orphans',
    description:
      'a ledger entry whose originating source row is gone (reconcile-ledger.sql A6)',
    sql: `
      SELECT le.id AS ledger_id, le.trigger_type, le.ref_table, le.ref_id
      FROM ledger_entries le
      WHERE (le.trigger_type IN ('read_accrual', 'pledge_fulfil')
               AND NOT EXISTS (SELECT 1 FROM read_events re WHERE re.id = le.ref_id))
         OR (le.trigger_type = 'tab_settlement'
               AND NOT EXISTS (SELECT 1 FROM tab_settlements ts WHERE ts.id = le.ref_id))
         OR (le.trigger_type = 'writer_payout'
               AND NOT EXISTS (SELECT 1 FROM writer_payouts wp WHERE wp.id = le.ref_id))
         OR (le.trigger_type = 'publication_split'
               AND NOT EXISTS (SELECT 1 FROM publication_payout_splits ps WHERE ps.id = le.ref_id))
         OR (le.trigger_type IN ('dispute_stake', 'dispute_stake_refund')
               AND NOT EXISTS (SELECT 1 FROM dispute_edges de WHERE de.id = le.ref_id))
         OR (le.trigger_type = 'tribute_payout'
               AND NOT EXISTS (SELECT 1 FROM tribute_payouts tp WHERE tp.id = le.ref_id))
         -- Reversals must resolve against the table each handler actually refs,
         -- not all against tab_settlements (the old bug: a real writer_payout_
         -- reversal / tribute_payout_reversal whose ref_id is a writer_payouts /
         -- tribute_payouts id would fail the tab_settlements lookup and halt ALL
         -- payouts on the next run — recurring forever, the entry being append-
         -- only). writer_payout_reversal is dual-table: F5 reuses it for
         -- publication-split-recipient reversals with ref_table
         -- 'publication_payout_splits'.
         OR (le.trigger_type = 'tab_settlement_reversal'
               AND NOT EXISTS (SELECT 1 FROM tab_settlements ts WHERE ts.id = le.ref_id))
         OR (le.trigger_type = 'writer_payout_reversal' AND le.ref_table = 'writer_payouts'
               AND NOT EXISTS (SELECT 1 FROM writer_payouts wp WHERE wp.id = le.ref_id))
         OR (le.trigger_type = 'writer_payout_reversal' AND le.ref_table = 'publication_payout_splits'
               AND NOT EXISTS (SELECT 1 FROM publication_payout_splits ps WHERE ps.id = le.ref_id))
         OR (le.trigger_type = 'tribute_payout_reversal'
               AND NOT EXISTS (SELECT 1 FROM tribute_payouts tp WHERE tp.id = le.ref_id))
      LIMIT ${SAMPLE_LIMIT}`,
  },
]

export interface ReconcileViolation {
  check: string
  description: string
  count: number
  sample: Array<Record<string, unknown>>
}

export interface ReconcileResult {
  ok: boolean
  checkedAt: string
  checksRun: number
  violations: ReconcileViolation[]
}

/**
 * Run every critical reader-tab check and collect the violations. PURE — it
 * takes no halt action, so the internal route and the worker can both call it,
 * and it is unit-testable against a scripted client. `runLedgerReconcileAndEnforce`
 * is the side-effecting wrapper that alerts + halts.
 */
export async function reconcileLedger(db: Queryable): Promise<ReconcileResult> {
  const violations: ReconcileViolation[] = []
  for (const check of CRITICAL_CHECKS) {
    const { rows } = await db.query(check.sql)
    if (rows.length > 0) {
      violations.push({
        check: check.name,
        description: check.description,
        count: rows.length,
        sample: rows.slice(0, 5),
      })
    }
  }
  return {
    ok: violations.length === 0,
    checkedAt: new Date().toISOString(),
    checksRun: CRITICAL_CHECKS.length,
    violations,
  }
}

/**
 * Run the reconciliation and enforce the §1.2 response: on ANY mismatch, ALERT
 * (a fatal-level structured log the ops alerting keys on) and HALT PAYOUTS (the
 * durable flag the three payout cycles refuse to run past). Used by both the
 * scheduled worker and the manual POST /reconcile-ledger route.
 */
export async function runLedgerReconcileAndEnforce(db: Queryable = pool): Promise<ReconcileResult> {
  const result = await reconcileLedger(db)
  if (!result.ok) {
    const summary = result.violations.map((v) => `${v.check}(${v.count})`).join(', ')
    const reason = `Ledger reconciliation mismatch: ${summary}`
    await haltPayouts(db, reason)
    // fatal, not error: this is the money-books-diverged alert — payouts are now
    // frozen and a human must reconcile before POST /payouts/resume.
    logger.fatal(
      { alert: 'payouts_halted', violations: result.violations },
      `PAYOUTS HALTED — ${reason}`,
    )
  } else {
    logger.info({ checksRun: result.checksRun }, 'Ledger reconciliation clean')
  }
  return result
}
