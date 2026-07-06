import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Writer-side accrual at settlement (item 3 final phase). When confirmSettlement
// advances reads to platform_settled, each read EARNS its writer the post-fee
// net — one writer_accrual ledger entry per read (account = writer, cp = reader),
// the earned-side mirror of the reader's tab_settlement credit. Pure mock test
// in the repo idiom: feed the settled-reads SELECT two rows and assert the
// entries posted.
// ---------------------------------------------------------------------------

vi.mock('stripe', () => ({ default: class { paymentIntents = {} } }))

const FEE = 800 // 8% → net = amount − floor(amount·800/10000)
const net = (a: number) => a - Math.floor((a * FEE) / 10000)

// Every query the confirm transaction issues, for shape assertions.
let clientCalls: Array<{ sql: string; params: any[] }> = []

function fakeClientQuery(sql: string, params: any[] = []) {
  clientCalls.push({ sql, params })
  if (sql.includes('FROM tab_settlements') && sql.includes('SELECT')) {
    return Promise.resolve({
      rows: [{ id: 'settle-1', reader_id: 'reader-1', tab_id: 'tab-1', amount_pence: 800, stripe_charge_id: null }],
      rowCount: 1,
    })
  }
  // The writer_accrual source SELECT — two settled reads for two writers.
  if (sql.includes('AS net_pence') && sql.includes('platform_settled')) {
    return Promise.resolve({
      rows: [
        { id: 'read-A', writer_id: 'writer-A', net_pence: String(net(500)) },
        { id: 'read-B', writer_id: 'writer-B', net_pence: String(net(300)) },
      ],
      rowCount: 2,
    })
  }
  return Promise.resolve({ rows: [], rowCount: 1 })
}

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: vi.fn() },
  loadConfig: vi.fn(async () => ({ platformFeeBps: FEE })),
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

describe('confirmSettlement — writer_accrual earned-side posting', () => {
  beforeEach(() => {
    recordLedger.mockClear()
    clientCalls = []
  })

  it('posts one writer_accrual per settled read (net, account=writer, cp=reader)', async () => {
    await settlementService.confirmSettlement('pi_1', 'ch_1')

    const accruals = recordLedger.mock.calls
      .map((c) => c[1])
      .filter((e) => e.triggerType === 'writer_accrual')

    expect(accruals).toHaveLength(2)
    expect(accruals).toContainEqual(
      expect.objectContaining({ accountId: 'writer-A', counterpartyId: 'reader-1', amountPence: net(500), triggerType: 'writer_accrual', refTable: 'read_events', refId: 'read-A' }),
    )
    expect(accruals).toContainEqual(
      expect.objectContaining({ accountId: 'writer-B', counterpartyId: 'reader-1', amountPence: net(300), triggerType: 'writer_accrual', refTable: 'read_events', refId: 'read-B' }),
    )
    // Plus the reader tab_settlement credit — earned side is additive, not a swap.
    expect(recordLedger.mock.calls.map((c) => c[1].triggerType)).toContain('tab_settlement')
  })

  it('stamps unsettled subscription_earnings collected (migration 146 gate)', async () => {
    await settlementService.confirmSettlement('pi_1', 'ch_1')

    // The subscription twin of the read advance: earnings for this reader
    // created at/before the settlement snapshot flip settled_at — the payout
    // cycle only claims stamped earnings. No ledger entry (posted at charge).
    const stamp = clientCalls.find(
      (c) =>
        /UPDATE subscription_events/.test(c.sql) &&
        /SET settled_at = now\(\)/.test(c.sql) &&
        /settled_at IS NULL/.test(c.sql) &&
        /subscription_earning/.test(c.sql) &&
        /created_at <= \(SELECT settled_at FROM tab_settlements/.test(c.sql),
    )
    expect(stamp).toBeDefined()
    expect(stamp!.params).toEqual(['reader-1', 'settle-1'])
  })
})
