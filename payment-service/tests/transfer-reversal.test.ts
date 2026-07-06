import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// transfer.reversed — PARTIAL reversal handling (2026-07-06 audit residual).
// Stripe emits the event for partial reversals too, carrying the CUMULATIVE
// transfer.amount_reversed. The handlers must post only the delta over the
// ledger's posted-so-far (idempotent under redelivery) and flip the row to
// 'reversed' only when fully reversed. Pure mock test in the repo idiom.
// ---------------------------------------------------------------------------

vi.mock('stripe', () => ({ default: class { transfers = {} } }))

// Scenario state the fake client reads: the payout row and the reversal total
// already in the ledger for it.
let payoutRow: { id: string; writer_id: string; amount_pence: number } | null = null
let postedReversalPence = 0
let statusFlips: string[] = []

function fakeClientQuery(sql: string, params: any[] = []) {
  if (/FROM writer_payouts/.test(sql) && /FOR UPDATE/.test(sql)) {
    return Promise.resolve({ rows: payoutRow ? [payoutRow] : [], rowCount: payoutRow ? 1 : 0 })
  }
  if (/FROM ledger_entries/.test(sql) && /writer_payout_reversal/.test(sql)) {
    return Promise.resolve({ rows: [{ posted: String(postedReversalPence) }], rowCount: 1 })
  }
  if (/UPDATE writer_payouts SET status = 'reversed'/.test(sql)) {
    statusFlips.push(params[0])
    return Promise.resolve({ rows: [], rowCount: 1 })
  }
  return Promise.resolve({ rows: [], rowCount: 1 })
}

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: vi.fn() },
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

import { payoutService } from '../src/services/payout.js'

describe('reverseWriterPayout — cumulative partial reversals', () => {
  beforeEach(() => {
    recordLedger.mockClear()
    payoutRow = { id: 'payout-1', writer_id: 'writer-1', amount_pence: 20000 }
    postedReversalPence = 0
    statusFlips = []
  })

  it('posts only the partial amount and does NOT flip the row', async () => {
    await payoutService.reverseWriterPayout('tr_1', 5000) // £50 of £200

    expect(recordLedger).toHaveBeenCalledOnce()
    expect(recordLedger.mock.calls[0][1]).toMatchObject({
      accountId: 'writer-1',
      amountPence: -5000,
      triggerType: 'writer_payout_reversal',
      refTable: 'writer_payouts',
      refId: 'payout-1',
    })
    expect(statusFlips).toHaveLength(0)
  })

  it('a later cumulative event posts the delta and flips at full reversal', async () => {
    postedReversalPence = 5000 // the £50 partial already posted
    await payoutService.reverseWriterPayout('tr_1', 20000) // now fully reversed

    expect(recordLedger).toHaveBeenCalledOnce()
    expect(recordLedger.mock.calls[0][1]).toMatchObject({ amountPence: -15000 })
    expect(statusFlips).toEqual(['payout-1'])
  })

  it('redelivery of an already-posted event is a no-op', async () => {
    postedReversalPence = 5000
    await payoutService.reverseWriterPayout('tr_1', 5000)

    expect(recordLedger).not.toHaveBeenCalled()
    expect(statusFlips).toHaveLength(0)
  })

  it('a missing amount_reversed falls back to the full amount (defensive)', async () => {
    await payoutService.reverseWriterPayout('tr_1', null)

    expect(recordLedger.mock.calls[0][1]).toMatchObject({ amountPence: -20000 })
    expect(statusFlips).toEqual(['payout-1'])
  })

  it('never reverses more than the payout amount', async () => {
    await payoutService.reverseWriterPayout('tr_1', 99999)

    expect(recordLedger.mock.calls[0][1]).toMatchObject({ amountPence: -20000 })
  })
})
