import { describe, it, expect, vi } from 'vitest'
import { recordLedger, applyLedgerDelta } from '@platform-pub/shared/lib/ledger.js'
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

// ---------------------------------------------------------------------------
// applyLedgerDelta contract (PAYMENTS ADR §1.8). The tab-debit / ledger-mirror
// primitive: it moves reading_tabs.balance_pence by a signed delta AND posts the
// mirror ledger entry at −delta, as one indivisible, UNCLAMPED pair. These are
// the structural proofs of the invariant that has actually lost money here (the
// three 2026-06-20 HIGH clamp/divergence findings) — the guarantee is now held
// by construction, so call sites only owe the RIGHT delta (proven per-site in
// settlement-ledger-parity.test.ts et al.). Pure no-DB tests: route the fake
// client's query so the reading_tabs upsert answers with a balance and the
// ledger insert answers with an id, then assert the SQL + params of both legs.
// ---------------------------------------------------------------------------
describe('applyLedgerDelta', () => {
  function fakeTabClient(balanceAfter = 250) {
    const query = vi.fn(async (sql: string) => {
      if (/INSERT INTO reading_tabs/.test(sql)) {
        return { rows: [{ id: 'tab-1', balance_pence: balanceAfter }], rowCount: 1 }
      }
      return { rows: [{ id: 'led-9' }], rowCount: 1 } // the ledger_entries insert
    })
    return { client: { query } as unknown as PoolClient, query }
  }
  const tabSql = (q: ReturnType<typeof vi.fn>) =>
    q.mock.calls.find(([sql]: [string]) => /INSERT INTO reading_tabs/.test(sql))!
  const ledgerSql = (q: ReturnType<typeof vi.fn>) =>
    q.mock.calls.find(([sql]: [string]) => /INSERT INTO ledger_entries/.test(sql))!

  it('upserts the tab by reader_id, adding the signed delta with NO clamp', async () => {
    const { client, query } = fakeTabClient()
    await applyLedgerDelta(client, {
      accountId: 'reader-1', counterpartyId: 'writer-1', deltaPence: 175,
      triggerType: 'read_accrual', refTable: 'read_events', refId: 're-1',
    })
    const [sql, params] = tabSql(query)
    expect(sql).toMatch(/ON CONFLICT \(reader_id\)/)
    expect(sql).toMatch(/balance_pence = reading_tabs\.balance_pence \+ EXCLUDED\.balance_pence/)
    expect(sql).not.toMatch(/GREATEST|LEAST/)
    expect(sql).toMatch(/RETURNING id, balance_pence/)
    expect(params).toEqual(['reader-1', 175])
  })

  it('posts the mirror ledger entry at −deltaPence (reader-tab convention)', async () => {
    const { client, query } = fakeTabClient()
    await applyLedgerDelta(client, {
      accountId: 'reader-1', counterpartyId: 'writer-1', deltaPence: 175,
      triggerType: 'read_accrual', refTable: 'read_events', refId: 're-1',
    })
    // (account_id, counterparty_id, amount_pence, currency, trigger_type, ref_table, ref_id)
    const [, params] = ledgerSql(query)
    expect(params[0]).toBe('reader-1')
    expect(params[1]).toBe('writer-1')
    expect(params[2]).toBe(-175) // balance +175 ⇒ ledger −175, derived not passed
    expect(params[3]).toBe('GBP')
    expect(params[4]).toBe('read_accrual')
  })

  it('mirrors a credit (negative delta) as a positive ledger entry, unfloored', async () => {
    const { client, query } = fakeTabClient(-200)
    await applyLedgerDelta(client, {
      accountId: 'reader-1', counterpartyId: null, deltaPence: -500,
      triggerType: 'tab_settlement', refTable: 'tab_settlements', refId: 'ts-1',
    })
    // The column moves −500 (may drive it negative — no floor); the ledger is +500.
    expect(tabSql(query)[1]).toEqual(['reader-1', -500])
    expect(ledgerSql(query)[1][2]).toBe(500)
    expect(tabSql(query)[0]).not.toMatch(/GREATEST|LEAST/)
  })

  it('returns the post-mutation balance and the ledger id', async () => {
    const { client } = fakeTabClient(250)
    const result = await applyLedgerDelta(client, {
      accountId: 'reader-1', deltaPence: 10,
      triggerType: 'dispute_stake', refTable: 'dispute_edges', refId: 'de-1',
    })
    expect(result).toEqual({ ledgerId: 'led-9', balancePence: 250, tabId: 'tab-1' })
  })

  it('bumps only allowlisted timestamp columns; always updated_at', async () => {
    const { client, query } = fakeTabClient()
    await applyLedgerDelta(client, {
      accountId: 'reader-1', deltaPence: 10, touch: ['last_read_at'],
      triggerType: 'read_accrual', refTable: 'read_events', refId: 're-1',
    })
    const [sql] = tabSql(query)
    expect(sql).toMatch(/updated_at = now\(\)/)
    expect(sql).toMatch(/last_read_at = now\(\)/)
    expect(sql).not.toMatch(/last_settled_at/)
  })

  it('sets last_settled_at when asked, and no timestamp extras by default', async () => {
    const { client, query } = fakeTabClient()
    await applyLedgerDelta(client, {
      accountId: 'reader-1', deltaPence: -20, touch: ['last_settled_at'],
      triggerType: 'tab_settlement', refTable: 'tab_settlements', refId: 'ts-1',
    })
    expect(tabSql(query)[0]).toMatch(/last_settled_at = now\(\)/)

    const { client: c2, query: q2 } = fakeTabClient()
    await applyLedgerDelta(c2, {
      accountId: 'reader-1', deltaPence: -20,
      triggerType: 'subscription_credit', refTable: 'subscriptions', refId: 's-1',
    })
    expect(tabSql(q2)[0]).not.toMatch(/last_read_at|last_settled_at/)
  })
})
