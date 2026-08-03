import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// syncAllocations — the TS composition around the exported SQL (§0o.2).
//
// The SQL halves (which charges are candidates, what the refund snapshot sums,
// what the stamp writes) are proven against a real Postgres in
// segregation-assembly-integration.test.ts. What only THIS file can pin is the
// method's composition, which is where the original §0o.2 bug lived:
//   • the refund snapshot is read BEFORE the Stripe retrieve (a refund landing
//     in between must err to under-draw)
//   • the stamp writes `retrieved remaining + snapshot`, never the raw
//     remaining
//   • a failed retrieve skips its row without stamping, and the sweep carries
//     on to the next candidate
// Pure mock test in the repo idiom (transfer-reversal.test.ts). The candidate
// answer is a FIXTURE here — its predicate (the drawn-charge exclusion, the
// unconditional NULL arm) is a property only Postgres can evaluate and is
// pinned in the DB-backed suite.
// ---------------------------------------------------------------------------

const S = vi.hoisted(() => {
  const state = {
    /** Rows the candidate query hands the loop. */
    candidates: [] as Array<{ id: string; stripe_payment_intent_id: string }>,
    /** allocated_draws fixture the snapshot SQL is answered from. */
    draws: [] as Array<{ settlement_id: string; kind: string; gross_pence: number }>,
    /** Stripe's remaining per PI (what the expanded retrieve reports). */
    remainingByPi: new Map<string, number>(),
    failPis: new Set<string>(),
    /** What the stamp wrote, per settlement. */
    stamps: [] as Array<{ id: string; value: number }>,
    /** Interleaved call trace — the snapshot-vs-retrieve ORDER is the point. */
    trace: [] as string[],
    reset() {
      state.candidates = []
      state.draws = []
      state.remainingByPi.clear()
      state.failPis.clear()
      state.stamps = []
      state.trace = []
    },
  }
  return state
})

function fakeQuery(sql: string, params: unknown[] = []) {
  // Candidate selection — fixture-fed (see the header for why that is honest).
  if (/FROM tab_settlements/.test(sql) && /allocated_pence IS NULL/.test(sql)) {
    return Promise.resolve({ rows: S.candidates, rowCount: S.candidates.length })
  }
  // Refund snapshot — answered from the SQL it is handed: the kind filter and
  // the settlement scope are both derivable from the statement + params.
  if (/FROM allocated_draws/.test(sql) && /kind = 'refund'/.test(sql)) {
    S.trace.push(`snapshot:${params[0]}`)
    const sum = S.draws
      .filter((d) => d.settlement_id === params[0] && d.kind === 'refund')
      .reduce((s, d) => s + d.gross_pence, 0)
    return Promise.resolve({ rows: [{ refund_pence: sum }], rowCount: 1 })
  }
  // The stamp.
  if (/UPDATE tab_settlements/.test(sql) && /allocated_pence = \$2/.test(sql)) {
    S.trace.push(`stamp:${params[0]}`)
    S.stamps.push({ id: params[0] as string, value: params[1] as number })
    return Promise.resolve({ rows: [], rowCount: 1 })
  }
  return Promise.resolve({ rows: [], rowCount: 1 })
}

vi.mock('stripe', () => ({
  default: class {
    paymentIntents = {
      retrieve: async (id: string) => {
        S.trace.push(`retrieve:${id}`)
        if (S.failPis.has(id)) throw { type: 'StripeRateLimitError' }
        return {
          latest_charge: {
            allocated_funds: {
              balance: { pending: 0, available: S.remainingByPi.get(id) ?? 0 },
            },
          },
        }
      },
    }
    customers = {}
    transfers = {}
  },
}))

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (sql: string, params: unknown[] = []) => fakeQuery(sql, params) },
  loadConfig: vi.fn(async () => ({ allocationSyncFreshnessHours: 24 })),
  withTransaction: (cb: (c: { query: typeof fakeQuery }) => Promise<unknown>) =>
    cb({ query: (sql: string, params: unknown[] = []) => fakeQuery(sql, params) }),
}))

vi.mock('@platform-pub/shared/lib/ledger.js', () => ({
  recordLedger: vi.fn(async () => undefined),
  applyLedgerDelta: vi.fn(async () => ({ ledgerId: 'l', balancePence: 0, tabId: 't' })),
}))

vi.mock('@platform-pub/shared/lib/env.js', () => ({
  tributesEnabled: () => false,
  allocatedFundsEnabled: () => true,
  ALLOCATED_FUNDS_API_VERSION: '2026-06-24.preview; allocated_funds_preview=v1',
}))

vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { settlementService } from '../src/services/settlement.js'

beforeEach(() => {
  S.reset()
})

describe('syncAllocations — stamp composition (§0o.2)', () => {
  it('stamps `retrieved remaining + refund snapshot`, never the raw remaining', async () => {
    // The first-sync-after-refund shape: Stripe reports 4700 because the 300
    // refund already left the charge; the recorded refund draw will be
    // subtracted by every budget read, so the stamp must put it back.
    S.candidates = [{ id: 's1', stripe_payment_intent_id: 'pi_1' }]
    S.draws = [{ settlement_id: 's1', kind: 'refund', gross_pence: 300 }]
    S.remainingByPi.set('pi_1', 4700)

    const res = await settlementService.syncAllocations()

    expect(res).toEqual({ checked: 1, synced: 1 })
    expect(S.stamps).toEqual([{ id: 's1', value: 5000 }])
  })

  it('reads the snapshot BEFORE the retrieve — the order every race argument rests on', async () => {
    S.candidates = [{ id: 's1', stripe_payment_intent_id: 'pi_1' }]
    S.remainingByPi.set('pi_1', 5000)

    await settlementService.syncAllocations()

    expect(S.trace).toEqual(['snapshot:s1', 'retrieve:pi_1', 'stamp:s1'])
  })

  it('skips a row whose retrieve failed — no stamp — and still syncs the next', async () => {
    S.candidates = [
      { id: 's1', stripe_payment_intent_id: 'pi_1' },
      { id: 's2', stripe_payment_intent_id: 'pi_2' },
    ]
    S.failPis.add('pi_1')
    S.remainingByPi.set('pi_2', 2500)

    const res = await settlementService.syncAllocations()

    expect(res).toEqual({ checked: 2, synced: 1 })
    expect(S.stamps).toEqual([{ id: 's2', value: 2500 }])
  })

  it('stamps 0 (not NULL, not skipped) for a charge carrying no allocation at all', async () => {
    // 0 means "we looked and there is nothing drawable" — it is what stops the
    // sweep re-reading an ineligible-brand or pre-flip charge every cycle.
    S.candidates = [{ id: 's1', stripe_payment_intent_id: 'pi_1' }]
    // remainingByPi deliberately unset → the double reports available 0.

    await settlementService.syncAllocations()

    expect(S.stamps).toEqual([{ id: 's1', value: 0 }])
  })
})
