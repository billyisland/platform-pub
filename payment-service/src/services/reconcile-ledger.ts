import { pool, loadConfig } from '@platform-pub/shared/db/client.js'
import logger from '../lib/logger.js'
import {
  haltPayouts,
  haltAccountPayouts,
  listHaltedAccounts,
  getPayoutHaltState,
  type AccountHalt,
  type Queryable,
} from '../lib/payout-halt.js'

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

// -----------------------------------------------------------------------------
// The orphan predicate (A6) and its ref_table sets — ONE home, two readers.
//
// The `ledger_orphans` check runs it CAPPED (existence is all a global halt
// needs) and W4's attribution runs it UNCAPPED (halting per account from a
// truncated payload silently pays the 21st diverging account). Two copies of a
// predicate this long is how the two come to disagree, and the disagreement
// would be invisible: the check would halt on a row the attribution never saw,
// or worse, the attribution would name an account the check no longer flags.
// So the predicate is written once and both statements are built from it.
//
// The ref_table lists are TS constants interpolated into the catch-all rather
// than literals inside the SQL, because `isAttributableOrphan` reads the SAME
// lists. A new ref_table branch added to the predicate without extending the
// list would make its rows unattributable — which fails SAFE (global halt), but
// only because these two readers share the list rather than each keeping one.
// -----------------------------------------------------------------------------

/** ref_tables `writer_payout_reversal` is legitimately posted against. */
const WRITER_REVERSAL_REF_TABLES = [
  'writer_payouts',
  'publication_payout_splits',
  'tab_settlements',
] as const

/** ref_tables `tribute_payout_reversal` is legitimately posted against. */
const TRIBUTE_REVERSAL_REF_TABLES = ['tribute_payouts', 'tab_settlements'] as const

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

/**
 * `le.account_id` is in the SELECT for W4: it is the ONLY recoverable handle on
 * whose divergence this is, the orphan's source row being by definition gone.
 */
const LEDGER_ORPHAN_COLUMNS = `le.id AS ledger_id, le.trigger_type, le.ref_table, le.ref_id, le.account_id`

const LEDGER_ORPHAN_PREDICATE = `
        (le.trigger_type IN ('read_accrual', 'pledge_fulfil')
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
         -- fail loud here (add its scoped branch above, then extend the list).
         OR (le.trigger_type = 'writer_payout_reversal'
               AND le.ref_table NOT IN (${sqlList(WRITER_REVERSAL_REF_TABLES)}))
         OR (le.trigger_type = 'tribute_payout_reversal'
               AND le.ref_table NOT IN (${sqlList(TRIBUTE_REVERSAL_REF_TABLES)}))`

/**
 * The W4 attribution statement: the SAME predicate, deliberately UNCAPPED.
 *
 * The cap on every other statement here is right — a global halt needs only
 * existence, so twenty rows is a sufficient starting point for a human. This one
 * decides WHOSE money stops, and a bound would mean the 21st diverging account
 * kept being paid out of a divergence we had already detected. If a bound is
 * ever reintroduced, a truncated result must fall back to the GLOBAL halt; a
 * partial per-account halt is the one outcome that must never happen.
 *
 * Exported so the DB-backed test executes the statement the service runs.
 */
export const LEDGER_ORPHAN_ATTRIBUTION_SQL = `
      SELECT ${LEDGER_ORPHAN_COLUMNS}
      FROM ledger_entries le
      WHERE ${LEDGER_ORPHAN_PREDICATE}`

/**
 * Trigger types whose orphaned entry names an account whose OWN payouts are the
 * ones to stop. Payout-side only, and the list is short on purpose.
 *
 * `reader_balance_parity` — the commonest divergence class — names a READER,
 * and mapping a reader to the writers they paid via `read_events` would halt
 * writers on the strength of someone else's divergence: over-broad by
 * construction, and the same ¶7.14.6 discretion W4 exists to narrow. Nothing
 * outside this set is attributable, so it halts globally instead.
 *
 * `dispute_stake` is deliberately ABSENT though it looks payout-shaped: the
 * stake debits the DISPUTANT's reading tab (it is counted by
 * `ledger_reader_balance`), so it is a reader-side trigger and halting that
 * account's payouts would be the same category error one table over.
 */
const ATTRIBUTABLE_ORPHAN_TRIGGERS = new Set(['writer_payout', 'publication_split', 'tribute_payout'])

export interface OrphanRow {
  trigger_type: string
  ref_table: string | null
  account_id: string | null
}

/**
 * Whether an orphan row can honestly be attributed to its account.
 *
 * A reversal is attributable only on a ref_table we RECOGNISE. The catch-all
 * branch above exists to fail loud on an unknown one — "we do not understand
 * this entry" — and narrowing the response to one account is precisely the
 * confidence we do not have there. So an unknown ref_table falls through to the
 * global halt, which is the default-deny posture that branch was written in.
 */
export function isAttributableOrphan(row: OrphanRow): boolean {
  if (!row.account_id) return false
  if (ATTRIBUTABLE_ORPHAN_TRIGGERS.has(row.trigger_type)) return true
  if (row.trigger_type === 'writer_payout_reversal') {
    return (WRITER_REVERSAL_REF_TABLES as readonly string[]).includes(row.ref_table ?? '')
  }
  if (row.trigger_type === 'tribute_payout_reversal') {
    return (TRIBUTE_REVERSAL_REF_TABLES as readonly string[]).includes(row.ref_table ?? '')
  }
  return false
}

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
      SELECT ${LEDGER_ORPHAN_COLUMNS}
      FROM ledger_entries le
      WHERE ${LEDGER_ORPHAN_PREDICATE}
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
   *
   * It says a halt-class divergence EXISTS, not that everyone was frozen: since
   * W4 a divergence that attributes to accounts halts only those. Whether this
   * run froze the platform is `enforcement.globalHalt`.
   */
  haltRequired: boolean
  checkedAt: string
  checksRun: number
  violations: ReconcileViolation[]
}

/** What the enforcement wrapper actually did — see `runLedgerReconcileAndEnforce`. */
export interface ReconcileEnforcement {
  /** The platform-wide freeze: only for divergences no check could attribute. */
  globalHalt: boolean
  /** Which classes forced it, so the halt record says what could not be attributed. */
  globalHaltClasses: string[]
  /** Accounts this run attributed a divergence to (halted, new or already). */
  attributedAccounts: AccountHalt[]
  /** Of those, how many were NOT already halted — first-writer-wins makes repeats 0. */
  newlyHaltedAccounts: number
  /** Halts (global or per-account) older than payout_halt_escalation_hours. */
  staleHalts: number
}

export interface EnforcedReconcileResult extends ReconcileResult {
  enforcement: ReconcileEnforcement
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
 * Attribute a halt-class violation to accounts where the check honestly can.
 *
 * Only `ledger_orphans` can: it is the one check whose violating rows name the
 * account whose OWN payouts should stop (see `ATTRIBUTABLE_ORPHAN_TRIGGERS`).
 * Every other halt-class check names a reader or names nobody, so it returns
 * `fullyAttributed: false` and the caller freezes the platform.
 *
 * Re-queries UNCAPPED rather than reading `violation.sample` — that sample is
 * five rows of twenty, and halting from it would pay everyone it omitted.
 */
async function attributeHaltingViolation(
  db: Queryable,
  violation: ReconcileViolation,
): Promise<{ halts: AccountHalt[]; fullyAttributed: boolean }> {
  if (violation.check !== 'ledger_orphans') return { halts: [], fullyAttributed: false }

  const { rows } = await db.query(LEDGER_ORPHAN_ATTRIBUTION_SQL)

  const halts = new Map<string, AccountHalt>()
  let unattributable = 0
  for (const raw of rows) {
    const row = raw as unknown as OrphanRow & { ledger_id?: string }
    if (!isAttributableOrphan(row)) {
      unattributable++
      continue
    }
    // First orphan per account wins the reason, matching the row-level
    // first-writer-wins in the table: the first divergence is the one to
    // investigate, and a Map keyed on the account keeps one row per account so
    // the batch INSERT cannot conflict with itself.
    if (!halts.has(row.account_id!)) {
      halts.set(row.account_id!, {
        accountId: row.account_id!,
        mismatchClass: violation.check,
        reason: `orphaned ${row.trigger_type} ledger entry ${row.ledger_id ?? '(unknown)'} (ref_table ${row.ref_table ?? 'null'})`,
      })
    }
  }

  // An empty result is NOT full attribution. The capped check found rows; if the
  // uncapped re-query finds none, something moved underneath us (or the two
  // statements disagree, which they cannot while both are built from the one
  // predicate) — either way we do not know whose divergence it is.
  const fullyAttributed = unattributable === 0 && halts.size > 0
  return { halts: [...halts.values()], fullyAttributed }
}

/**
 * Escalate a halt that has outlived the configured bound — global or
 * per-account, and INDEPENDENT of whether this run found anything.
 *
 * That independence is the whole point. A halt that is never cleared is
 * indistinguishable from a policy of not paying, and the way it happens is that
 * a human fixes the DATA and never clears the FLAG: every subsequent run
 * reconciles clean, logs "clean", and pays nobody. Dev sat exactly like that for
 * a fortnight from 2026-07-17, silently, with nothing wrong with the payout code
 * (scripts/backfill-seed-opening-balances.ts header). So this runs on every
 * reconciliation, including the clean ones — especially the clean ones.
 */
async function escalateStaleHalts(db: Queryable, maxAgeHours: number): Promise<number> {
  const cutoff = Date.now() - maxAgeHours * 3_600_000
  const isStale = (since: string | null) => since !== null && Date.parse(since) < cutoff

  const [global, accounts] = await Promise.all([getPayoutHaltState(db), listHaltedAccounts(db)])
  const staleGlobal = global.halted && isStale(global.since)
  const staleAccounts = accounts.filter((a) => isStale(a.since))
  const total = staleAccounts.length + (staleGlobal ? 1 : 0)

  if (total > 0) {
    logger.fatal(
      {
        alert: 'payout_halt_stale',
        maxAgeHours,
        globalHalt: staleGlobal ? { since: global.since, reason: global.reason } : null,
        accounts: staleAccounts,
      },
      `PAYOUT HALT UNRESOLVED for over ${maxAgeHours}h — ${staleGlobal ? 'the platform-wide halt' : ''}${staleGlobal && staleAccounts.length ? ' and ' : ''}${staleAccounts.length ? `${staleAccounts.length} account(s)` : ''} still frozen. A halt nobody clears is a policy of not paying.`,
    )
  }
  return total
}

/**
 * Run the reconciliation and enforce the §1.2 response, per severity:
 *   • any 'halt' violation → ALERT (a fatal-level structured log the ops
 *     alerting keys on) and HALT PAYOUTS — platform-wide unless the violation
 *     attributes to accounts, in which case only those accounts freeze (W4).
 *   • any 'alert' violation → ALERT ONLY, with its OWN marker (`alert` = the
 *     check name), and nobody's payouts move. See the SEVERITY note at the head
 *     of this file for why a negative reading tab must not freeze payouts.
 * The two are independent: an alert-only incident in the same run as a
 * divergence emits both, and an alert-only run never touches the halt flag.
 * Used by both the scheduled worker and the manual POST /reconcile-ledger route.
 *
 * W4 — WHY THE GLOBAL HALT IS NOT SIMPLY REPLACED. The narrow instrument is not
 * a relaxation of the broad one: a divergence that cannot be attributed still
 * freezes everything, and the global reason names the class that could not be.
 * The two also coexist within one run — a `ledger_orphans` violation carrying
 * both a writer's orphan and a reader's halts that writer AND the platform, so
 * clearing the global halt later does not quietly release the account.
 */
export async function runLedgerReconcileAndEnforce(
  db: Queryable = pool,
): Promise<EnforcedReconcileResult> {
  const result = await reconcileLedger(db)

  const halting = result.violations.filter((v) => v.severity === 'halt')
  const alerting = result.violations.filter((v) => v.severity === 'alert')

  const attributedAccounts: AccountHalt[] = []
  const globalHaltClasses: string[] = []

  for (const violation of halting) {
    const { halts, fullyAttributed } = await attributeHaltingViolation(db, violation)
    attributedAccounts.push(...halts)
    if (!fullyAttributed) globalHaltClasses.push(violation.check)
  }

  let newlyHaltedAccounts = 0
  if (attributedAccounts.length > 0) {
    newlyHaltedAccounts = await haltAccountPayouts(db, attributedAccounts)
    logger.fatal(
      {
        alert: 'payouts_halted_account',
        accounts: attributedAccounts,
        newlyHalted: newlyHaltedAccounts,
      },
      `ACCOUNT PAYOUTS HALTED — ${attributedAccounts.length} account(s) with an attributable ledger divergence (${newlyHaltedAccounts} newly). Everyone else keeps being paid.`,
    )
  }

  if (globalHaltClasses.length > 0) {
    const unattributable = halting.filter((v) => globalHaltClasses.includes(v.check))
    const reason = `Ledger reconciliation mismatch (unattributable): ${summarise(unattributable)}`
    await haltPayouts(db, reason)
    // fatal, not error: this is the money-books-diverged alert — payouts are now
    // frozen and a human must reconcile before POST /payouts/resume.
    logger.fatal({ alert: 'payouts_halted', violations: unattributable }, `PAYOUTS HALTED — ${reason}`)
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

  // Unconditional, including on a clean run — see escalateStaleHalts.
  const config = await loadConfig()
  const staleHalts = await escalateStaleHalts(db, config.payoutHaltEscalationHours)

  if (result.ok) {
    logger.info({ checksRun: result.checksRun }, 'Ledger reconciliation clean')
  }
  return {
    ...result,
    enforcement: {
      globalHalt: globalHaltClasses.length > 0,
      globalHaltClasses,
      attributedAccounts,
      newlyHaltedAccounts,
      staleHalts,
    },
  }
}
