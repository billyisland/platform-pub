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

// Segregation (FUNDS-SEGREGATION §3.5): the handler resolves a CHILD first, so
// the mock has to answer that lookup. `children` empty = the legacy
// single-transfer payout, which is what the original suite below exercises.
interface FakeChild {
  id: string
  parent_table: string
  parent_id: string
  settlement_id: string | null
  stripe_charge_id: string | null
  funding: 'allocated' | 'platform_balance'
  net_pence: number
  fee_pence: number
  reversed_pence: number
  status: string
  stripe_transfer_id: string
}
let children: FakeChild[] = []
let draws: Array<{ ref_id: string; kind: string; gross_pence: number }> = []

function fakeClientQuery(sql: string, params: any[] = []) {
  // --- payout_transfers (children) ----------------------------------------
  if (/FROM payout_transfers/.test(sql) && /stripe_transfer_id = \$1/.test(sql)) {
    const found = children.filter((c) => c.stripe_transfer_id === params[0])
    return Promise.resolve({ rows: found, rowCount: found.length })
  }
  if (/FROM payout_transfers/.test(sql) && /reversed_pence/.test(sql) && /FOR UPDATE/.test(sql)) {
    // Mirrors the SQL's own status filter — a child not in (completed, reversed)
    // must not be found, or the test would pin the fixture rather than the query.
    const found = children.filter(
      (c) => c.id === params[0] && ['completed', 'reversed'].includes(c.status),
    )
    return Promise.resolve({ rows: found, rowCount: found.length })
  }
  if (/SUM\(net_pence - reversed_pence\)/.test(sql)) {
    // Derived from the SQL it is handed, per the mock rule: the status set IS
    // the §0o.3 fix (pending counts as standing), so restating it here would
    // pin this fixture's list against a query that silently changed.
    const statusList = sql.match(/status IN \(([^)]+)\)/)
    if (!statusList) throw new Error(`outstanding tally lost its status filter: ${sql}`)
    const statuses = statusList[1].split(',').map((s) => s.trim().replace(/'/g, ''))
    const outstanding = children
      .filter((c) => c.parent_id === params[0] && statuses.includes(c.status))
      .reduce((s, c) => s + (c.net_pence - c.reversed_pence), 0)
    return Promise.resolve({ rows: [{ outstanding: String(outstanding) }], rowCount: 1 })
  }
  if (/UPDATE payout_transfers SET reversed_pence/.test(sql)) {
    const c = children.find((x) => x.id === params[0])
    if (c) c.reversed_pence = params[1]
    return Promise.resolve({ rows: [], rowCount: c ? 1 : 0 })
  }
  if (/UPDATE payout_transfers SET status = 'reversed'/.test(sql)) {
    const c = children.find((x) => x.id === params[0])
    if (c) c.status = 'reversed'
    return Promise.resolve({ rows: [], rowCount: c ? 1 : 0 })
  }
  if (/INSERT INTO allocated_draws/.test(sql)) {
    draws.push({ ref_id: params[1], kind: 'reversal', gross_pence: params[2] })
    return Promise.resolve({ rows: [], rowCount: 1 })
  }

  // --- legacy single-transfer payout --------------------------------------
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
  pool: { query: (sql: string, params: any[] = []) => fakeClientQuery(sql, params) },
  loadConfig: vi.fn(async () => ({ platformFeeBps: 800 })),
  withTransaction: (cb: (client: any) => Promise<any>) =>
    cb({ query: (sql: string, params: any[] = []) => fakeClientQuery(sql, params) }),
}))

vi.mock('@platform-pub/shared/lib/env.js', () => ({
  tributesEnabled: () => false,
  allocatedFundsEnabled: () => true,
  ALLOCATED_FUNDS_API_VERSION: '2026-06-24.preview; allocated_funds_preview=v1',
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
    children = []
    draws = []
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

// ---------------------------------------------------------------------------
// Reversal of ONE CHILD among several (FUNDS-SEGREGATION §3.5, §5 step 7b).
//
// This is the case that forced the re-keying. Under segregation a payout is N
// transfers, but `writer_payouts.stripe_transfer_id` holds ONE id — so a
// handler keyed on it finds nothing for any other child and drops the event
// SILENTLY. Silence is what makes it dangerous: no error, no log, and the
// writer keeps money Stripe has already clawed back.
// ---------------------------------------------------------------------------

function child(over: Partial<FakeChild> = {}): FakeChild {
  return {
    id: 'child-a',
    parent_table: 'writer_payouts',
    parent_id: 'payout-1',
    settlement_id: 'settle-1',
    stripe_charge_id: 'ch_1',
    funding: 'allocated',
    net_pence: 8000,
    fee_pence: 700,
    reversed_pence: 0,
    status: 'completed',
    stripe_transfer_id: 'tr_child_a',
    ...over,
  }
}

describe('reverseWriterPayout — one child among several', () => {
  beforeEach(() => {
    recordLedger.mockClear()
    payoutRow = { id: 'payout-1', writer_id: 'writer-1', amount_pence: 20000 }
    postedReversalPence = 0
    statusFlips = []
    draws = []
    children = [
      child({ id: 'child-a', stripe_transfer_id: 'tr_child_a', net_pence: 8000 }),
      child({ id: 'child-b', stripe_transfer_id: 'tr_child_b', net_pence: 12000 }),
    ]
  })

  it('reverses THAT child only, leaving siblings and the parent standing', async () => {
    await payoutService.reverseWriterPayout('tr_child_a', 8000)

    // Its own net, not the parent's amount.
    expect(recordLedger).toHaveBeenCalledOnce()
    expect(recordLedger.mock.calls[0][1]).toMatchObject({
      accountId: 'writer-1',
      amountPence: -8000,
      triggerType: 'writer_payout_reversal',
      // The ref stays the PARENT — ledger_publication_distribution's filter and
      // reconcile-ledger's ledger_orphans catch-all both depend on it.
      refTable: 'writer_payouts',
      refId: 'payout-1',
    })
    expect(children.find((c) => c.id === 'child-a')!.status).toBe('reversed')
    expect(children.find((c) => c.id === 'child-b')!.status).toBe('completed')
    // £120 of the payout is still outstanding, so the parent is NOT reversed.
    expect(statusFlips).toHaveLength(0)
  })

  it('returns the funds to the ALLOCATED state, not to platform balance', async () => {
    await payoutService.reverseWriterPayout('tr_child_a', 8000)

    // A compensating draw, negative, so the charge's remainder grows back and
    // the next cycle can draw on it again.
    expect(draws).toEqual([
      { ref_id: 'child-a', kind: 'reversal', gross_pence: -8000 },
    ])
  })

  it('touches no allocation for a RESIDUAL child (it never held any)', async () => {
    children = [child({ funding: 'platform_balance', settlement_id: null, stripe_charge_id: null })]
    await payoutService.reverseWriterPayout('tr_child_a', 8000)

    expect(recordLedger.mock.calls[0][1]).toMatchObject({ amountPence: -8000 })
    expect(draws).toHaveLength(0)
  })

  it('posts only the DELTA on a staged partial, then flips at full reversal', async () => {
    await payoutService.reverseWriterPayout('tr_child_a', 3000)
    expect(recordLedger.mock.calls[0][1]).toMatchObject({ amountPence: -3000 })
    expect(children[0].status).toBe('completed')

    await payoutService.reverseWriterPayout('tr_child_a', 8000)
    expect(recordLedger.mock.calls[1][1]).toMatchObject({ amountPence: -5000 })
    expect(children[0].status).toBe('reversed')
  })

  it('is a no-op on redelivery — the child, not the parent, is the guard', async () => {
    children[0].reversed_pence = 8000
    children[0].status = 'reversed'
    await payoutService.reverseWriterPayout('tr_child_a', 8000)

    expect(recordLedger).not.toHaveBeenCalled()
    expect(draws).toHaveLength(0)
  })

  it('reverses the PARENT once every child is fully reversed', async () => {
    await payoutService.reverseWriterPayout('tr_child_a', 8000)
    await payoutService.reverseWriterPayout('tr_child_b', 12000)

    expect(statusFlips).toEqual(['payout-1'])
  })

  it('does NOT flip the parent while a sibling is still PENDING (§0o.3)', async () => {
    // Child A completed, crash before B executed, A fully reversed before the
    // next cycle. Flipping the parent here removes it from the resume sweeps
    // (which scan pending parents only), freezing B and its claimed units
    // forever. B's untouched net must count as outstanding.
    children = [
      child({ id: 'child-a', stripe_transfer_id: 'tr_child_a', net_pence: 8000 }),
      child({
        id: 'child-b',
        stripe_transfer_id: 'tr_child_b',
        net_pence: 12000,
        status: 'pending',
      }),
    ]
    await payoutService.reverseWriterPayout('tr_child_a', 8000)

    expect(children.find((c) => c.id === 'child-a')!.status).toBe('reversed')
    expect(statusFlips).toHaveLength(0)
  })

  it('a FAILED sibling does not hold the flip open — nothing moved, nothing will', async () => {
    // failChild released a failed child's units, so it is not standing money in
    // either direction: excluded from outstanding, and the reversed sibling
    // alone decides the flip.
    children = [
      child({ id: 'child-a', stripe_transfer_id: 'tr_child_a', net_pence: 8000 }),
      child({
        id: 'child-b',
        stripe_transfer_id: 'tr_child_b',
        net_pence: 12000,
        status: 'failed',
      }),
    ]
    await payoutService.reverseWriterPayout('tr_child_a', 8000)

    expect(statusFlips).toEqual(['payout-1'])
  })

  it('never reverses more than the child (not the parent) is worth', async () => {
    await payoutService.reverseWriterPayout('tr_child_a', 99999)

    expect(recordLedger.mock.calls[0][1]).toMatchObject({ amountPence: -8000 })
  })
})
