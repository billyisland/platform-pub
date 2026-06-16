import { describe, it, expect, vi } from 'vitest'
import { recordLedger } from '@platform-pub/shared/lib/ledger.js'
import type { PoolClient } from 'pg'

// ---------------------------------------------------------------------------
// recordLedger contract (Architecture-audit item 3, Phase 1).
//
// recordLedger is the single funnel every money path posts through. These are
// pure, no-DB tests (the repo has no DB-backed harness): they lock the helper's
// contract — column/param ORDER, signed-amount passthrough, and the
// counterparty/currency defaults — so a refactor can't silently reorder params
// or drop a sign. The rollback property (entry absent if the enclosing txn
// aborts) is structural: recordLedger issues its INSERT on the caller's
// in-flight client, so it commits/rolls back with that txn by construction —
// same guarantee as enqueueRelayPublish, and only meaningfully assertable
// against a live DB (deferred with the rest of the DB-backed harness). Call-site
// SIGN correctness is verified at Phase 2 reconciliation, by design.
// ---------------------------------------------------------------------------

function fakeClient(): { client: PoolClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: 'led-1' }], rowCount: 1 })
  // Only .query is exercised; cast through unknown for the rest of PoolClient.
  return { client: { query } as unknown as PoolClient, query }
}

describe('recordLedger', () => {
  it('inserts into ledger_entries with params in column order', async () => {
    const { client, query } = fakeClient()
    await recordLedger(client, {
      accountId: 'acc-1',
      counterpartyId: 'acc-2',
      amountPence: -250,
      currency: 'GBP',
      triggerType: 'read_accrual',
      refTable: 'read_events',
      refId: 're-1',
    })

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('INSERT INTO ledger_entries')
    // (account_id, counterparty_id, amount_pence, currency, trigger_type, ref_table, ref_id)
    expect(params).toEqual(['acc-1', 'acc-2', -250, 'GBP', 'read_accrual', 'read_events', 're-1'])
  })

  it('preserves a signed (debit) amount unchanged', async () => {
    const { client, query } = fakeClient()
    await recordLedger(client, {
      accountId: 'acc-1',
      amountPence: -1799,
      triggerType: 'vote_charge',
      refTable: 'vote_charges',
      refId: 'vc-1',
    })
    expect(query.mock.calls[0][1][2]).toBe(-1799)
  })

  it('preserves a signed (credit) amount unchanged', async () => {
    const { client, query } = fakeClient()
    await recordLedger(client, {
      accountId: 'acc-1',
      amountPence: 800,
      triggerType: 'writer_payout',
      refTable: 'writer_payouts',
      refId: 'wp-1',
    })
    expect(query.mock.calls[0][1][2]).toBe(800)
  })

  it('defaults counterparty to NULL (platform) and currency to GBP', async () => {
    const { client, query } = fakeClient()
    await recordLedger(client, {
      accountId: 'acc-1',
      amountPence: 500,
      triggerType: 'tab_settlement',
      refTable: 'tab_settlements',
      refId: 'ts-1',
    })
    const params = query.mock.calls[0][1]
    expect(params[1]).toBeNull()   // counterparty_id
    expect(params[3]).toBe('GBP')  // currency
  })

  it('returns the inserted row id', async () => {
    const { client } = fakeClient()
    const result = await recordLedger(client, {
      accountId: 'acc-1',
      amountPence: 1,
      triggerType: 'pledge_fulfil',
      refTable: 'read_events',
      refId: 're-2',
    })
    expect(result).toEqual({ id: 'led-1' })
  })
})
