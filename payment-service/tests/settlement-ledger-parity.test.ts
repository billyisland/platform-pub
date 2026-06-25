import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Settlement ↔ ledger parity (four-day-commit audit, HIGH finding #1).
//
// confirmSettlement must move reading_tabs.balance_pence and the ledger entry
// by the SAME signed delta. The bug was a `GREATEST(0, balance_pence - $1)`
// clamp on the column while recordLedger posted the full unclamped +amount: if
// the balance had dropped below the settle amount between reservation and
// confirmation (e.g. an interleaved subscription credit-back) the column floored
// at 0 while the ledger kept the full credit → −SUM(ledger) ≠ balance_pence
// permanently (the Phase-3 "agree to the penny" invariant). Migration 124 dropped
// the reading_tabs_balance_non_negative CHECK so the column may now go negative.
//
// Pure mock test in the repo idiom (no DB harness): we record the SQL the
// confirm transaction issues and assert the reading_tabs UPDATE is the unclamped
// `balance_pence - $1` and the ledger credit equals the full settle amount.
// ---------------------------------------------------------------------------

// Stripe is constructed at module load; stub it so no real key is needed.
vi.mock('stripe', () => ({ default: class { paymentIntents = {} } }))

let txCalls: Array<{ sql: string; params: any[] }> = []

// Route the fake client's query by SQL fragment so confirmSettlement runs to
// completion (it destructures rowCount and reads rows[0]).
function fakeClientQuery(sql: string, params: any[] = []) {
  txCalls.push({ sql, params })
  if (sql.includes('FROM tab_settlements') && sql.includes('SELECT')) {
    return Promise.resolve({
      rows: [{
        id: 'settle-1',
        reader_id: 'reader-1',
        tab_id: 'tab-1',
        amount_pence: 500,        // settle amount > the 300 the tab now holds
        stripe_charge_id: null,
      }],
      rowCount: 1,
    })
  }
  // every UPDATE (claim, reading_tabs, read_events, vote_charges) → 1 row
  return Promise.resolve({ rows: [], rowCount: 1 })
}

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: vi.fn() },
  // confirmSettlement now loads config unconditionally (for the writer_accrual
  // per-read net). The settled-reads SELECT returns the empty default below, so
  // no writer_accrual is posted and recordLedger is still called once.
  loadConfig: vi.fn(async () => ({ platformFeeBps: 800 })),
  withTransaction: (cb: (client: any) => Promise<any>) =>
    cb({ query: (sql: string, params: any[] = []) => fakeClientQuery(sql, params) }),
}))

const recordLedger = vi.fn(async () => undefined)
vi.mock('@platform-pub/shared/lib/ledger.js', () => ({
  recordLedger: (...args: any[]) => recordLedger(...args),
}))

vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { settlementService } from '../src/services/settlement.js'

describe('confirmSettlement — column/ledger parity', () => {
  beforeEach(() => {
    txCalls = []
    recordLedger.mockClear()
  })

  it('debits reading_tabs by the full settle amount with NO GREATEST clamp', async () => {
    await settlementService.confirmSettlement('pi_123', 'ch_123')

    const tabUpdate = txCalls.find(
      (c) => c.sql.includes('UPDATE reading_tabs') && c.sql.includes('balance_pence'),
    )
    expect(tabUpdate).toBeDefined()
    // The fix: unclamped subtraction — the column tracks the ledger exactly.
    expect(tabUpdate!.sql).toMatch(/balance_pence\s*=\s*balance_pence\s*-\s*\$1/)
    // Regression guard: the clamp that diverged column from ledger must not return.
    expect(tabUpdate!.sql).not.toContain('GREATEST')
    expect(tabUpdate!.params[0]).toBe(500)
  })

  it('posts a ledger credit equal to the full (unclamped) settle amount', async () => {
    await settlementService.confirmSettlement('pi_123', 'ch_123')

    expect(recordLedger).toHaveBeenCalledTimes(1)
    const entry = recordLedger.mock.calls[0][1]
    expect(entry).toMatchObject({
      accountId: 'reader-1',
      counterpartyId: null,
      amountPence: 500,            // == the column delta above → parity holds
      triggerType: 'tab_settlement',
      refTable: 'tab_settlements',
    })
  })
})
