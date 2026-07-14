import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Settlement ↔ ledger parity (four-day-commit audit, HIGH finding #1; the
// pairing re-homed to applyLedgerDelta by PAYMENTS ADR §1.8).
//
// confirmSettlement must pay the tab DOWN and credit the ledger by the SAME
// unclamped magnitude. The original bug was a `GREATEST(0, balance_pence - $1)`
// clamp on the column while recordLedger posted the full +amount: if the balance
// had dropped below the settle amount between reservation and confirmation the
// column floored at 0 while the ledger kept the full credit → −SUM(ledger) ≠
// balance_pence permanently. Migration 124 dropped the >= 0 CHECK so the column
// may now go negative.
//
// Since §1.8 the column⇄ledger pairing is owned by applyLedgerDelta, which
// derives the ledger sign from the column delta and structurally cannot clamp —
// its own mirror/no-clamp guarantee is proven once in ledger.test.ts. This test
// now proves the remaining call-site obligation: confirmSettlement hands
// applyLedgerDelta the RIGHT column delta — deltaPence = −amount_pence (the full
// settle amount, no floor), tagged tab_settlement — and does NOT post the tab
// credit through a bare recordLedger (which would double-count or escape the
// mirror). Pure mock test in the repo idiom (no DB harness).
// ---------------------------------------------------------------------------

// Stripe is constructed at module load; stub it so no real key is needed.
vi.mock('stripe', () => ({ default: class { paymentIntents = {} } }))

// Route the fake client's query by SQL fragment so confirmSettlement runs to
// completion (it destructures rowCount and reads rows[0]). The tab move + its
// mirror ledger entry now go through the (mocked) applyLedgerDelta, so the fake
// client no longer needs to answer the reading_tabs UPDATE.
function fakeClientQuery(sql: string, _params: any[] = []) {
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
  // every other query (FOR UPDATE lock, claim, settled-reads SELECT → empty) → 1 row
  return Promise.resolve({ rows: [], rowCount: 1 })
}

const applyLedgerDelta = vi.fn(async () => ({ ledgerId: 'led-1', balancePence: -200, tabId: 'tab-1' }))
const recordLedger = vi.fn(async () => ({ id: 'led-x' }))
vi.mock('@platform-pub/shared/lib/ledger.js', () => ({
  applyLedgerDelta: (...args: any[]) => applyLedgerDelta(...args),
  recordLedger: (...args: any[]) => recordLedger(...args),
}))

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: vi.fn() },
  // confirmSettlement loads config unconditionally (for the writer_accrual
  // per-read net). The settled-reads SELECT returns empty above, so no
  // writer_accrual is posted.
  loadConfig: vi.fn(async () => ({ platformFeeBps: 800 })),
  withTransaction: (cb: (client: any) => Promise<any>) =>
    cb({ query: (sql: string, params: any[] = []) => fakeClientQuery(sql, params) }),
}))

vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { settlementService } from '../src/services/settlement.js'

describe('confirmSettlement — column/ledger parity via applyLedgerDelta', () => {
  beforeEach(() => {
    applyLedgerDelta.mockClear()
    recordLedger.mockClear()
  })

  it('debits the tab by the full (unclamped) settle amount', async () => {
    await settlementService.confirmSettlement('pi_123', 'ch_123')

    const settlementCall = applyLedgerDelta.mock.calls.find(
      (c) => (c[1] as any)?.triggerType === 'tab_settlement',
    )
    expect(settlementCall).toBeDefined()
    const arg = settlementCall![1] as any
    // deltaPence = −500: the column moves DOWN by the full amount, no GREATEST
    // floor. applyLedgerDelta derives the +500 ledger credit from this, so parity
    // holds by construction (see ledger.test.ts for the primitive's own proof).
    expect(arg.deltaPence).toBe(-500)
    expect(arg).toMatchObject({
      accountId: 'reader-1',
      counterpartyId: null,
      triggerType: 'tab_settlement',
      refTable: 'tab_settlements',
    })
  })

  it('does not post the reader credit through a bare recordLedger', async () => {
    await settlementService.confirmSettlement('pi_123', 'ch_123')

    // The tab_settlement credit is applyLedgerDelta's job; a direct recordLedger
    // for it would escape the mirror (the pre-§1.8 shape).
    const bareTabSettlement = recordLedger.mock.calls.find(
      (c) => (c[1] as any)?.triggerType === 'tab_settlement',
    )
    expect(bareTabSettlement).toBeUndefined()
  })
})
