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
//
// SEVERITY (added 2026-08-06, PAYMENT-PERIMETER-ADR W1). Not every "must always
// be empty" set is a books-divergence:
//   • 'halt'  — the ledger and its column disagree. Money leaving the door is
//               money we cannot account for, so ALL payouts freeze.
//   • 'alert' — the books AGREE; they agree about a state that must not persist.
//               A negative reading tab is the case that forced the tier: it is a
//               reader-redeemable claim on VNL (HJ §6) with a defined outward
//               response (refund the card), and it reconciles perfectly while it
//               sits there. Freezing every Writer's payout over one Reader's
//               credit would itself be a ¶7.14.6 discretion — the exact marker
//               the perimeter work exists to narrow. So it alerts, loudly, and
//               moves nobody's money.
// The tier lives HERE and not in allocation-reconcile.ts (the other alert-only
// sweep) deliberately: `runAllocationReconcile` short-circuits whenever
// `allocatedFundsEnabled()` is false, so a check riding that file would be a
// silent no-op for exactly as long as STRIPE_ALLOCATED_FUNDS ships dark.
// =============================================================================

/** See the SEVERITY note above. 'halt' freezes all payouts; 'alert' never does. */
type CheckSeverity = 'halt' | 'alert'

interface Check {
  name: string
  description: string
  severity: CheckSeverity
  sql: string
}

// LIMIT bounds the alert payload; existence — not the exact count — is what
// trips the halt, so a capped sample is sufficient for the human to start from.
// For an 'alert' check the payload IS the response, so a truncated result must
// not read as a complete one: every violation carries `truncated` and the
// summary line says `20+` (see `reconcileLedger`). W4's per-account halting
// attribution has a stronger requirement still — it must run UNCAPPED, because
// halting from a truncated payload silently pays the 21st diverging account.
const SAMPLE_LIMIT = 20

/**
 * The negative-reading-tab detector, exported as its ONE home so the DB-backed
 * test (`tests/negative-reader-tab-integration.test.ts`) runs the statement this
 * service actually executes rather than a retyped copy of it. Only Postgres can
 * prove the LATERAL join resolves and the columns exist; a mocked `pool.query`
 * would pin the fixture.
 *
 * Why this needed a new check at all: a negative tab that AGREES with its ledger
 * passes `reader_balance_parity` silently — parity only compares the two. That
 * is exactly how the August 2026 double-charge left a reader £14 in credit with
 * nothing alerting (see the comment above `resumePendingSettlements` in
 * settlement.ts, which narrates it).
 *
 * It watches the COLUMN, so it covers every writer of it without naming them:
 * settlement's confirm/reverse legs, the dispute stake in gateway
 * `routes/upstream-edges.ts`, and the spend→subscription credit-back in gateway
 * `routes/articles/subscription-convert.ts`. All three go through
 * `applyLedgerDelta`, which is the column's only writer.
 *
 * The most recent settlement is the best available handle on "the settlement
 * that produced it" — the tab carries no per-movement provenance, and the
 * double-charge shape puts the culprit at the top of that list. It is a starting
 * point for the human, not an attribution.
 *
 * ORDER BY balance ASC so a truncated sample holds the DEEPEST credits — the
 * most material ones — rather than an arbitrary twenty.
 */
export const NEGATIVE_READER_TAB_SQL = `
      SELECT rt.reader_id                    AS account_id,
             rt.balance_pence                AS credit_pence,
             rt.last_settled_at,
             ls.id                           AS last_settlement_id,
             ls.amount_pence                 AS last_settlement_pence,
             ls.status                       AS last_settlement_status,
             ls.stripe_payment_intent_id     AS last_settlement_intent,
             ls.settled_at                   AS last_settlement_at
      FROM reading_tabs rt
      LEFT JOIN LATERAL (
        SELECT ts.id, ts.amount_pence, ts.status, ts.stripe_payment_intent_id, ts.settled_at
        FROM tab_settlements ts
        WHERE ts.reader_id = rt.reader_id
        ORDER BY ts.settled_at DESC
        LIMIT 1
      ) ls ON TRUE
      WHERE rt.balance_pence < 0
      ORDER BY rt.balance_pence ASC
      LIMIT ${SAMPLE_LIMIT}`

const CRITICAL_CHECKS: Check[] = [
  {
    name: 'reader_balance_parity',
    severity: 'halt',
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
    severity: 'halt',
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
    severity: 'halt',
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
    severity: 'halt',
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
    severity: 'halt',
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
         -- only). BOTH reversal triggers are multi-table: F5 reuses
         -- writer_payout_reversal for publication-split-recipient reversals
         -- (ref_table 'publication_payout_splits'), and the chargeback planner
         -- (settlement.ts reverseSettlement) posts writer_payout_reversal AND
         -- tribute_payout_reversal with ref_table 'tab_settlements'. Every
         -- branch is ref_table-scoped — an unscoped branch flags the other
         -- handlers' rows as orphans forever (§0f item 3).
         OR (le.trigger_type = 'tab_settlement_reversal'
               AND NOT EXISTS (SELECT 1 FROM tab_settlements ts WHERE ts.id = le.ref_id))
         OR (le.trigger_type = 'writer_payout_reversal' AND le.ref_table = 'writer_payouts'
               AND NOT EXISTS (SELECT 1 FROM writer_payouts wp WHERE wp.id = le.ref_id))
         OR (le.trigger_type = 'writer_payout_reversal' AND le.ref_table = 'publication_payout_splits'
               AND NOT EXISTS (SELECT 1 FROM publication_payout_splits ps WHERE ps.id = le.ref_id))
         OR (le.trigger_type = 'writer_payout_reversal' AND le.ref_table = 'tab_settlements'
               AND NOT EXISTS (SELECT 1 FROM tab_settlements ts WHERE ts.id = le.ref_id))
         OR (le.trigger_type = 'tribute_payout_reversal' AND le.ref_table = 'tribute_payouts'
               AND NOT EXISTS (SELECT 1 FROM tribute_payouts tp WHERE tp.id = le.ref_id))
         OR (le.trigger_type = 'tribute_payout_reversal' AND le.ref_table = 'tab_settlements'
               AND NOT EXISTS (SELECT 1 FROM tab_settlements ts WHERE ts.id = le.ref_id))
         -- Catch-all: ref_table-scoped branches are default-ALLOW — a reversal
         -- posted with a ref_table outside the known set matches no branch and
         -- is silently unchecked forever. The next F5-style trigger reuse must
         -- fail loud here (add its scoped branch above, then extend this list).
         OR (le.trigger_type = 'writer_payout_reversal'
               AND le.ref_table NOT IN ('writer_payouts', 'publication_payout_splits', 'tab_settlements'))
         OR (le.trigger_type = 'tribute_payout_reversal'
               AND le.ref_table NOT IN ('tribute_payouts', 'tab_settlements'))
      LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    name: 'negative_reader_tab',
    severity: 'alert',
    description:
      'a reading tab in credit (balance_pence < 0) is a reader-redeemable claim on the platform — an INCIDENT whose only resolution is an outward refund, never a legal state (PAYMENT-PERIMETER-ADR W1; runbook docs/runbooks/reader-tab-credit.md)',
    sql: NEGATIVE_READER_TAB_SQL,
  },
]

export interface ReconcileViolation {
  check: string
  description: string
  severity: CheckSeverity
  count: number
  /** True when the sample hit SAMPLE_LIMIT — `count` is then a floor, not a total. */
  truncated: boolean
  sample: Array<Record<string, unknown>>
}

export interface ReconcileResult {
  ok: boolean
  /**
   * True iff at least one violation is a 'halt' class. Derived and pure, so the
   * route's JSON and the tests can both read the halt decision without
   * re-deriving it from severities — and so an alert-only run reads as
   * "incident, payouts still flowing" rather than an unexplained `ok: false`.
   */
  haltRequired: boolean
  checkedAt: string
  checksRun: number
  violations: ReconcileViolation[]
}

/** `name(count)`, with `20+` where the sample was capped. */
function summarise(violations: ReconcileViolation[]): string {
  return violations.map((v) => `${v.check}(${v.count}${v.truncated ? '+' : ''})`).join(', ')
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
        severity: check.severity,
        count: rows.length,
        truncated: rows.length >= SAMPLE_LIMIT,
        sample: rows.slice(0, 5),
      })
    }
  }
  return {
    ok: violations.length === 0,
    haltRequired: violations.some((v) => v.severity === 'halt'),
    checkedAt: new Date().toISOString(),
    checksRun: CRITICAL_CHECKS.length,
    violations,
  }
}

/**
 * Run the reconciliation and enforce the §1.2 response, per severity:
 *   • any 'halt' violation → ALERT (a fatal-level structured log the ops
 *     alerting keys on) and HALT PAYOUTS (the durable flag the three payout
 *     cycles refuse to run past).
 *   • any 'alert' violation → ALERT ONLY, with its OWN marker (`alert` = the
 *     check name), and nobody's payouts move. See the SEVERITY note at the head
 *     of this file for why a negative reading tab must not freeze payouts.
 * The two are independent: an alert-only incident in the same run as a
 * divergence emits both, and an alert-only run never touches the halt flag.
 * Used by both the scheduled worker and the manual POST /reconcile-ledger route.
 */
export async function runLedgerReconcileAndEnforce(db: Queryable = pool): Promise<ReconcileResult> {
  const result = await reconcileLedger(db)

  const halting = result.violations.filter((v) => v.severity === 'halt')
  const alerting = result.violations.filter((v) => v.severity === 'alert')

  if (halting.length > 0) {
    const reason = `Ledger reconciliation mismatch: ${summarise(halting)}`
    await haltPayouts(db, reason)
    // fatal, not error: this is the money-books-diverged alert — payouts are now
    // frozen and a human must reconcile before POST /payouts/resume.
    logger.fatal({ alert: 'payouts_halted', violations: halting }, `PAYOUTS HALTED — ${reason}`)
  }

  for (const violation of alerting) {
    // The marker IS the check name, so each alert-tier class gets its own
    // configurable alert (DEPLOYMENT.md keys log alerts on stable markers) and a
    // new one can never inherit an existing rule's urgency by accident. fatal
    // because these are money incidents with a same-day human response, not
    // background noise — the marker, not the level, distinguishes them from a
    // halt.
    logger.fatal(
      { alert: violation.check, violations: [violation] },
      `INCIDENT — ${violation.check}(${violation.count}${violation.truncated ? '+' : ''}); payouts NOT halted. ${violation.description}`,
    )
  }

  if (result.ok) {
    logger.info({ checksRun: result.checksRun }, 'Ledger reconciliation clean')
  }
  return result
}
