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
vi.mock('@platform-pub/shared/db/client.js', () => ({ pool: {} }))

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
function configClient(): Queryable & { now: Date | null; reason: string | null } {
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
          state.updated_at = new Date('2026-07-14T12:00:00Z')
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
    const db = configClient()
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
function reconcileClient(violatingChecks: Set<string>): Queryable & { halted(): boolean; haltReason(): string | null } {
  const cfg = configClient()
  return {
    halted() { return cfg['now'] !== null },
    haltReason() { return cfg.reason },
    async query(sql: string, params: unknown[] = []) {
      if (/platform_config/.test(sql)) return cfg.query(sql, params)
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

beforeEach(() => { vi.clearAllMocks() })
