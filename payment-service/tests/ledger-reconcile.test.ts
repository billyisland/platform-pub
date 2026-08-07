import { describe, it, expect, beforeEach, vi } from 'vitest'

// =============================================================================
// §1.2 — scheduled ledger reconciliation + payout-halt control.
//
// Covers the halt primitive (durable flag round-trip, first-writer-wins) and
// the reconciliation service (clean → no halt; any violating check → halt +
// enforce), driven against a scripted platform_config-backed client. The three
// payout cycles' halt gate is verified against the real conformance harnesses;
// here we verify the primitive/service they depend on.
// =============================================================================

vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}))
// `loadConfig` supplies the halt-escalation bound. Mocked at a fixed 24h so the
// escalation tests move the CLOCK (the halt's age) rather than the threshold —
// a test that tuned the dial to force the alert would pass equally against a
// reader that ignored the dial entirely.
vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: {},
  loadConfig: async () => ({ payoutHaltEscalationHours: 24 }),
}))

import logger from '../src/lib/logger.js'
import {
  isPayoutsHalted,
  haltPayouts,
  resumePayouts,
  getPayoutHaltState,
  type Queryable,
} from '../src/lib/payout-halt.js'
import { reconcileLedger, runLedgerReconcileAndEnforce } from '../src/services/reconcile-ledger.js'

// ---------------------------------------------------------------------------
// A minimal platform_config-backed client honouring the exact SQL the halt
// primitive issues (select / first-writer-wins upsert / delete).
// ---------------------------------------------------------------------------
/**
 * `haltAt` is what the upsert stamps as the halt time. It defaults to the real
 * NOW because halt AGE is behaviour now (W4's escalation): a fixture pinned to
 * a fixed past date would make every freshly-created halt read as ancient, and
 * the escalation tests would then be passing on the mock's clock rather than on
 * the code's rule. Tests that need an OLD halt pass one explicitly.
 */
function configClient(haltAt: Date = new Date()): Queryable & { now: Date | null; reason: string | null } {
  const state = { value: null as string | null, description: null as string | null, updated_at: null as Date | null }
  const client = {
    get now() { return state.updated_at },
    get reason() { return state.description },
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*SELECT value FROM platform_config/.test(sql)) {
        return { rows: state.value === null ? [] : [{ value: state.value }] }
      }
      if (/^\s*SELECT value, description, updated_at FROM platform_config/.test(sql)) {
        return { rows: state.value === null ? [] : [{ value: state.value, description: state.description, updated_at: state.updated_at }] }
      }
      if (/INSERT INTO platform_config/.test(sql)) {
        // first-writer-wins: the WHERE guard skips the upsert if already 'true'
        if (state.value !== 'true') {
          state.value = 'true'
          state.description = params[1] as string
          state.updated_at = haltAt
        }
        return { rows: [] }
      }
      if (/DELETE FROM platform_config/.test(sql)) {
        state.value = null; state.description = null; state.updated_at = null
        return { rows: [] }
      }
      throw new Error(`unhandled sql: ${sql}`)
    },
  }
  return client
}

describe('payout halt flag', () => {
  it('round-trips: not halted → halt → halted → resume → not halted', async () => {
    const db = configClient(new Date('2026-07-14T12:00:00Z'))
    expect(await isPayoutsHalted(db)).toBe(false)

    await haltPayouts(db, 'reader_balance_parity(3)')
    expect(await isPayoutsHalted(db)).toBe(true)

    const state = await getPayoutHaltState(db)
    expect(state).toEqual({ halted: true, reason: 'reader_balance_parity(3)', since: '2026-07-14T12:00:00.000Z' })

    await resumePayouts(db)
    expect(await isPayoutsHalted(db)).toBe(false)
    expect(await getPayoutHaltState(db)).toEqual({ halted: false, reason: null, since: null })
  })

  it('first-writer-wins: a second halt preserves the ORIGINAL reason', async () => {
    const db = configClient()
    await haltPayouts(db, 'first divergence')
    await haltPayouts(db, 'later, different divergence')
    expect((await getPayoutHaltState(db)).reason).toBe('first divergence')
  })

  it('getPayoutHaltState surfaces a Date since as an ISO string', async () => {
    const db = configClient()
    await haltPayouts(db, 'x')
    expect(typeof (await getPayoutHaltState(db)).since).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Reconciliation service: a client that returns configurable check violations
// plus honours the halt upsert.
// ---------------------------------------------------------------------------
interface HaltRow { account_id: string; mismatch_class: string; reason: string; created_at: Date }

/**
 * Orphan rows the ATTRIBUTION query returns, per scenario. Deliberately
 * separate from the capped check's fixture: the two statements are built from
 * one predicate but answer different questions, and a mock that conflated them
 * could not show attribution reading more rows than the sample carries.
 */
const ORPHAN_ATTRIBUTION_FIXTURES: Record<string, Array<Record<string, unknown>>> = {
  // A writer's own payout entry orphaned — the attributable case.
  'ledger_orphans:attributable': [
    { ledger_id: 'l1', trigger_type: 'writer_payout', ref_table: 'writer_payouts', account_id: 'writer-1' },
    { ledger_id: 'l2', trigger_type: 'publication_split', ref_table: 'publication_payout_splits', account_id: 'member-2' },
  ],
  // A reader-side orphan alongside a writer's: attribution is PARTIAL, so the
  // platform freezes as well.
  'ledger_orphans:mixed': [
    { ledger_id: 'l1', trigger_type: 'writer_payout', ref_table: 'writer_payouts', account_id: 'writer-1' },
    { ledger_id: 'l3', trigger_type: 'read_accrual', ref_table: 'read_events', account_id: 'reader-9' },
  ],
  // The catch-all branch: a reversal on a ref_table we do not recognise. It
  // names an account, but "we do not understand this entry" is not the
  // confidence a per-account halt needs.
  'ledger_orphans:unknown_ref_table': [
    { ledger_id: 'l4', trigger_type: 'writer_payout_reversal', ref_table: 'some_new_table', account_id: 'writer-1' },
  ],
  // The dispute stake looks payout-shaped and is not: it debits the DISPUTANT's
  // reading tab, so halting their payouts is a reader→writer category error.
  'ledger_orphans:dispute_stake': [
    { ledger_id: 'l5', trigger_type: 'dispute_stake', ref_table: 'dispute_edges', account_id: 'reader-4' },
  ],
}

function reconcileClient(violatingChecks: Set<string>, haltAt?: Date): Queryable & {
  halted(): boolean
  haltReason(): string | null
  haltedAccounts(): HaltRow[]
  seedHaltedAccount(row: Partial<HaltRow> & { account_id: string }): void
  attributionSql(): string | null
} {
  const cfg = configClient(haltAt)
  const accounts: HaltRow[] = []
  let seenAttributionSql: string | null = null

  const orphanScenario = () =>
    [...violatingChecks].find((c) => c.startsWith('ledger_orphans:')) ?? null

  return {
    halted() { return cfg['now'] !== null },
    haltReason() { return cfg.reason },
    haltedAccounts() { return accounts },
    seedHaltedAccount(row) {
      accounts.push({
        account_id: row.account_id,
        mismatch_class: row.mismatch_class ?? 'ledger_orphans',
        reason: row.reason ?? 'seeded',
        created_at: row.created_at ?? new Date(),
      })
    },
    attributionSql() { return seenAttributionSql },
    async query(sql: string, params: unknown[] = []) {
      // loadConfig's read — answered by the vi.mock above, never reaching here.
      if (/SELECT key, value FROM platform_config/.test(sql)) return { rows: [] }
      if (/platform_config/.test(sql)) return cfg.query(sql, params)

      // ---- payouts_halted_accounts (W4) -----------------------------------
      if (/INSERT INTO payouts_halted_accounts/.test(sql)) {
        // Honour the real statement's shape: three parallel arrays through
        // unnest, ON CONFLICT DO NOTHING, RETURNING only the NEW rows.
        const [ids, classes, reasons] = params as [string[], string[], string[]]
        const inserted: Array<{ account_id: string }> = []
        ids.forEach((id, i) => {
          if (accounts.some((a) => a.account_id === id)) return // first-writer-wins
          accounts.push({ account_id: id, mismatch_class: classes[i], reason: reasons[i], created_at: new Date() })
          inserted.push({ account_id: id })
        })
        return { rows: inserted }
      }
      if (/SELECT account_id, mismatch_class, reason, created_at\s+FROM payouts_halted_accounts/.test(sql)) {
        return { rows: [...accounts].sort((a, b) => +a.created_at - +b.created_at) }
      }
      if (/DELETE FROM payouts_halted_accounts/.test(sql)) {
        const idx = accounts.findIndex((a) => a.account_id === params[0])
        if (idx === -1) return { rows: [] }
        const [gone] = accounts.splice(idx, 1)
        return { rows: [{ account_id: gone.account_id }] }
      }
      if (/SELECT 1 FROM payouts_halted_accounts/.test(sql)) {
        return { rows: accounts.filter((a) => a.account_id === params[0]).map(() => ({ '?column?': 1 })) }
      }
      // Each critical check SELECTs violation rows. Return one row iff this
      // check is configured to violate; the check is identified by a distinctive
      // fragment of its SQL.
      const violates = (frag: string) => (sql.includes(frag) ? [{ marker: 1 }] : [])
      if (/FROM reading_tabs rt\s+FULL OUTER JOIN ledger_reader_balance/.test(sql)) {
        return { rows: violatingChecks.has('reader_balance_parity') ? [{ account_id: 'a', tab_balance_pence: 10, ledger_balance_pence: 0 }] : [] }
      }
      if (/JOIN read_events re ON re\.id = le\.ref_id/.test(sql)) {
        return { rows: violatingChecks.has('read_accrual_magnitude') ? violates('') : [] }
      }
      if (/JOIN tab_settlements ts ON ts\.id = le\.ref_id/.test(sql)) {
        return { rows: violatingChecks.has('tab_settlement_magnitude') ? [{ ledger_id: 'l' }] : [] }
      }
      if (/JOIN dispute_edges de ON de\.id = le\.ref_id/.test(sql)) {
        return { rows: violatingChecks.has('dispute_stake_integrity') ? [{ ledger_id: 'l' }] : [] }
      }
      if (/le\.trigger_type IN \('read_accrual', 'pledge_fulfil'\)\s+AND NOT EXISTS/.test(sql)) {
        // The capped CHECK and the uncapped ATTRIBUTION share one predicate and
        // are told apart the only way that is honest: by whether the statement
        // carries a LIMIT. That is the distinction the code itself makes, so a
        // future edit that capped the attribution would land here as a changed
        // answer rather than sailing through.
        const isAttribution = !/LIMIT \d+\s*$/.test(sql.trim())
        const scenario = orphanScenario()
        if (isAttribution) {
          seenAttributionSql = sql
          if (scenario) return { rows: ORPHAN_ATTRIBUTION_FIXTURES[scenario] ?? [] }
          // Bare 'ledger_orphans': an orphan naming no account at all.
          return { rows: violatingChecks.has('ledger_orphans') ? [{ ledger_id: 'l', trigger_type: 'tab_settlement', ref_table: 'tab_settlements', account_id: null }] : [] }
        }
        if (scenario) return { rows: [{ ledger_id: 'l' }] }
        return { rows: violatingChecks.has('ledger_orphans') ? [{ ledger_id: 'l' }] : [] }
      }
      if (/WHERE rt\.balance_pence < 0/.test(sql)) {
        // Derive the row count from the SQL's own LIMIT where the scenario asks
        // for a truncated sample — the mock must answer from the SQL it is
        // handed, not from a fixture that ignores it.
        const limit = Number(/LIMIT (\d+)\s*$/.exec(sql.trim())?.[1] ?? 1)
        if (violatingChecks.has('negative_reader_tab:truncated')) {
          return {
            rows: Array.from({ length: limit }, (_, i) => ({
              account_id: `reader-${i}`,
              credit_pence: -100 - i,
              last_settlement_id: `stl-${i}`,
            })),
          }
        }
        return {
          rows: violatingChecks.has('negative_reader_tab')
            ? [{ account_id: 'reader-1', credit_pence: -1400, last_settlement_id: 'stl-1' }]
            : [],
        }
      }
      throw new Error(`unhandled reconcile sql: ${sql}`)
    },
  }
}

describe('reconcileLedger', () => {
  it('clean books: ok, no violations, does NOT halt when enforced', async () => {
    const db = reconcileClient(new Set())
    const result = await reconcileLedger(db)
    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(0)
    expect(result.haltRequired).toBe(false)
    expect(result.checksRun).toBe(6)

    const enforced = await runLedgerReconcileAndEnforce(db)
    expect(enforced.ok).toBe(true)
    expect(db.halted()).toBe(false)
  })

  it('a reader-balance divergence halts payouts with a descriptive reason', async () => {
    const db = reconcileClient(new Set(['reader_balance_parity']))
    const result = await runLedgerReconcileAndEnforce(db)
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.check)).toContain('reader_balance_parity')
    expect(db.halted()).toBe(true)
    expect(db.haltReason()).toContain('reader_balance_parity')
  })

  it('every critical check independently trips the halt', async () => {
    for (const check of [
      'reader_balance_parity',
      'read_accrual_magnitude',
      'tab_settlement_magnitude',
      'dispute_stake_integrity',
      'ledger_orphans',
    ]) {
      const db = reconcileClient(new Set([check]))
      const result = await runLedgerReconcileAndEnforce(db)
      expect(result.ok, `${check} should trip`).toBe(false)
      expect(db.halted(), `${check} should halt`).toBe(true)
    }
  })

  it('reports every violating check in one pass (multiple divergences)', async () => {
    const db = reconcileClient(new Set(['reader_balance_parity', 'ledger_orphans']))
    const result = await reconcileLedger(db)
    expect(result.violations.map((v) => v.check).sort()).toEqual(['ledger_orphans', 'reader_balance_parity'])
  })
})

// ---------------------------------------------------------------------------
// PAYMENT-PERIMETER-ADR W1 — a negative reading tab is an INCIDENT, not a legal
// state, and its response is an alert that freezes nobody's payouts. Freezing
// every Writer's money over one Reader's credit would itself be the ¶7.14.6
// discretion the perimeter work exists to narrow.
// ---------------------------------------------------------------------------
describe('negative reading tab (alert tier)', () => {
  it('alerts, names the account and the settlement, and does NOT halt payouts', async () => {
    const db = reconcileClient(new Set(['negative_reader_tab']))
    const result = await runLedgerReconcileAndEnforce(db)

    expect(result.ok).toBe(false)
    expect(result.haltRequired).toBe(false)
    expect(db.halted()).toBe(false) // ← the whole point of the tier

    const violation = result.violations.find((v) => v.check === 'negative_reader_tab')
    expect(violation?.severity).toBe('alert')
    expect(violation?.sample[0]).toMatchObject({
      account_id: 'reader-1',
      credit_pence: -1400,
      last_settlement_id: 'stl-1',
    })

    // Alerted under its OWN marker, not the halt's.
    expect(logger.fatal).toHaveBeenCalledTimes(1)
    const [fields, message] = vi.mocked(logger.fatal).mock.calls[0] as [Record<string, unknown>, string]
    expect(fields.alert).toBe('negative_reader_tab')
    expect(message).toContain('payouts NOT halted')
  })

  it('a divergence in the SAME run still halts, and both alerts are emitted', async () => {
    const db = reconcileClient(new Set(['negative_reader_tab', 'reader_balance_parity']))
    const result = await runLedgerReconcileAndEnforce(db)

    expect(result.haltRequired).toBe(true)
    expect(db.halted()).toBe(true)
    // The halt reason names ONLY the halting class — an alert-tier incident must
    // never appear as a reason payouts are frozen.
    expect(db.haltReason()).toContain('reader_balance_parity')
    expect(db.haltReason()).not.toContain('negative_reader_tab')

    const markers = vi.mocked(logger.fatal).mock.calls.map((c) => (c[0] as Record<string, unknown>).alert)
    expect(markers).toEqual(['payouts_halted', 'negative_reader_tab'])
  })

  it('a capped sample reports as a floor, never as a total', async () => {
    const db = reconcileClient(new Set(['negative_reader_tab:truncated']))
    const result = await runLedgerReconcileAndEnforce(db)

    const violation = result.violations.find((v) => v.check === 'negative_reader_tab')
    expect(violation?.truncated).toBe(true)
    // 20 rows returned because the SQL asked for 20 — the mock reads the LIMIT
    // out of the query rather than pinning a fixture.
    expect(violation?.count).toBe(20)

    const [, message] = vi.mocked(logger.fatal).mock.calls[0] as [unknown, string]
    expect(message).toContain('negative_reader_tab(20+)')
  })
})

// ---------------------------------------------------------------------------
// PAYMENT-PERIMETER-ADR W4 — narrow the global payout halt.
//
// The control being narrowed is the largest surviving HJ ¶7.14.6 marker: as
// built, ANY ledger divergence froze every writer's, publication's and
// tribute's money on the strength of a divergence that might implicate one.
//
// THE PAIRED ASSERTION IS THE POINT, and it is the same shape as W1's: every
// test that asserts an account was halted also asserts whether the PLATFORM
// was. "The account is frozen" is worthless on its own — it is equally true of
// the global halt this work exists to replace.
// ---------------------------------------------------------------------------
describe('per-account payout halt (W4)', () => {
  it('an attributable orphan halts those accounts and NOT the platform', async () => {
    const db = reconcileClient(new Set(['ledger_orphans:attributable']))
    const result = await runLedgerReconcileAndEnforce(db)

    expect(result.haltRequired).toBe(true) // a halt-class divergence exists…
    expect(db.halted()).toBe(false) // …and nobody else's payouts stopped
    expect(result.enforcement.globalHalt).toBe(false)
    expect(result.enforcement.globalHaltClasses).toEqual([])

    expect(db.haltedAccounts().map((a) => a.account_id).sort()).toEqual(['member-2', 'writer-1'])
    expect(result.enforcement.newlyHaltedAccounts).toBe(2)
    // The class is the check name, and the reason names the offending row —
    // an operator must be able to tell WHICH divergence caught them.
    expect(db.haltedAccounts()[0].mismatch_class).toBe('ledger_orphans')
    expect(db.haltedAccounts()[0].reason).toContain('writer_payout')
    expect(db.haltedAccounts()[0].reason).toContain('l1')

    const markers = vi.mocked(logger.fatal).mock.calls.map((c) => (c[0] as Record<string, unknown>).alert)
    expect(markers).toEqual(['payouts_halted_account'])
  })

  it('a PARTIALLY attributable orphan halts the account AND the platform', async () => {
    // The reader-side orphan in the same check is exactly what the global flag
    // is still for. Both halts must land: clearing the platform halt later must
    // not quietly release the writer.
    const db = reconcileClient(new Set(['ledger_orphans:mixed']))
    const result = await runLedgerReconcileAndEnforce(db)

    expect(db.halted()).toBe(true)
    expect(result.enforcement.globalHalt).toBe(true)
    expect(result.enforcement.globalHaltClasses).toEqual(['ledger_orphans'])
    expect(db.haltedAccounts().map((a) => a.account_id)).toEqual(['writer-1'])
    // The reader is named by the divergence but is NOT halted — halting a
    // reader's payouts over their own reading-tab entry is the category error.
    expect(db.haltedAccounts().map((a) => a.account_id)).not.toContain('reader-9')
    // And the reason says the halt is the unattributable remainder.
    expect(db.haltReason()).toContain('unattributable')
  })

  it('an unrecognised reversal ref_table falls back to the GLOBAL halt', async () => {
    // The catch-all branch exists to fail loud on a trigger reuse nobody has
    // taught this file about. Narrowing the response to one account is
    // precisely the confidence we do not have there.
    const db = reconcileClient(new Set(['ledger_orphans:unknown_ref_table']))
    await runLedgerReconcileAndEnforce(db)

    expect(db.halted()).toBe(true)
    expect(db.haltedAccounts()).toHaveLength(0)
  })

  it('a dispute_stake orphan is reader-side: global halt, no account frozen', async () => {
    const db = reconcileClient(new Set(['ledger_orphans:dispute_stake']))
    await runLedgerReconcileAndEnforce(db)

    expect(db.halted()).toBe(true)
    expect(db.haltedAccounts()).toHaveLength(0)
  })

  it('every OTHER halt-class check still freezes the platform', async () => {
    // W4 narrows one class, not the control. reader_balance_parity — the
    // commonest divergence — names a reader and stays global by design.
    for (const check of [
      'reader_balance_parity',
      'read_accrual_magnitude',
      'tab_settlement_magnitude',
      'dispute_stake_integrity',
    ]) {
      const db = reconcileClient(new Set([check]))
      await runLedgerReconcileAndEnforce(db)
      expect(db.halted(), `${check} must still halt globally`).toBe(true)
      expect(db.haltedAccounts(), `${check} must attribute to nobody`).toHaveLength(0)
    }
  })

  it('the attribution query is UNCAPPED', async () => {
    // Halting per account from a truncated payload silently pays the 21st
    // diverging account. This asserts the property directly rather than
    // inferring it from a row count, so a LIMIT reintroduced with a large
    // bound still fails.
    const db = reconcileClient(new Set(['ledger_orphans:attributable']))
    await runLedgerReconcileAndEnforce(db)
    expect(db.attributionSql()).not.toBeNull()
    expect(db.attributionSql()).not.toMatch(/LIMIT/i)
  })

  it('re-detecting the same orphan does not re-halt or refresh the halt', async () => {
    // The ledger is append-only, so an orphan re-detects on EVERY run until a
    // human acts. An upsert would refresh created_at each time, making a
    // fortnight-old halt read as new and defeating the escalation below.
    const db = reconcileClient(new Set(['ledger_orphans:attributable']))
    await runLedgerReconcileAndEnforce(db)
    const firstSeen = db.haltedAccounts().map((a) => +a.created_at)

    const second = await runLedgerReconcileAndEnforce(db)
    expect(second.enforcement.newlyHaltedAccounts).toBe(0)
    expect(db.haltedAccounts()).toHaveLength(2)
    expect(db.haltedAccounts().map((a) => +a.created_at)).toEqual(firstSeen)
  })
})

describe('halt escalation (W4 — a halt nobody clears is a policy of not paying)', () => {
  it('escalates a per-account halt older than the bound, on an otherwise CLEAN run', async () => {
    // The clean run is the case that matters. The way a halt becomes permanent
    // is that a human fixes the DATA and not the FLAG: every later run
    // reconciles clean, logs "clean", and pays nobody. Dev sat exactly so for a
    // fortnight from 2026-07-17.
    const db = reconcileClient(new Set())
    db.seedHaltedAccount({
      account_id: 'writer-1',
      created_at: new Date(Date.now() - 48 * 3_600_000),
    })

    const result = await runLedgerReconcileAndEnforce(db)
    expect(result.ok).toBe(true) // the books are clean…
    expect(result.enforcement.staleHalts).toBe(1) // …and someone is still frozen

    const [fields, message] = vi.mocked(logger.fatal).mock.calls[0] as [Record<string, unknown>, string]
    expect(fields.alert).toBe('payout_halt_stale')
    expect(message).toContain('24h')
  })

  it('a halt YOUNGER than the bound does not escalate', async () => {
    const db = reconcileClient(new Set())
    db.seedHaltedAccount({
      account_id: 'writer-1',
      created_at: new Date(Date.now() - 2 * 3_600_000),
    })

    const result = await runLedgerReconcileAndEnforce(db)
    expect(result.enforcement.staleHalts).toBe(0)
    expect(logger.fatal).not.toHaveBeenCalled()
  })

  it('a stale GLOBAL halt escalates too', async () => {
    // Stamped 48h ago — the halt a human raised, investigated and never cleared.
    const db = reconcileClient(new Set(), new Date(Date.now() - 48 * 3_600_000))
    await haltPayouts(db, 'an old divergence nobody cleared')

    const result = await runLedgerReconcileAndEnforce(db)
    expect(result.enforcement.staleHalts).toBe(1)
    expect(vi.mocked(logger.fatal).mock.calls.map((c) => (c[0] as Record<string, unknown>).alert))
      .toContain('payout_halt_stale')
  })
})

beforeEach(() => { vi.clearAllMocks() })
