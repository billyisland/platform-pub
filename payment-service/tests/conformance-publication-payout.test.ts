import { describe, it, expect, beforeEach, vi } from 'vitest'
import { connectionError, invalidRequest, type LedgerRow } from './support/conformance.js'

// =============================================================================
// PUBLICATION PAYOUT saga — conformance battery (PAYMENTS ADR §1.1 step 1).
//
// The MULTI-LEG transfer saga: one publication_payouts parent fans out to N
// publication_payout_splits, each paid by its OWN transfers.create under a
// per-leg ROW-stable key `pub-split-<payoutId>-<splitId>` (split.id, never
// account_id — one account can hold two splits in a payout). The worst blast radius
// of the four flows (partial double-pay), so the headline scenario is the
// multi-leg crash: crash after leg 2 of 4 → legs 1–2 stay 'completed' and are
// NEVER re-paid, legs 3–4 complete on resume EXACTLY once, parent completes only
// when every leg has.
//
// Driven through resumePendingPublicationPayouts() (public) against a seeded
// reserved parent + splits — the reserve/computePublicationSplits math is proven
// separately in payout-math.test.ts, so this file isolates the per-leg pay /
// crash / resume machinery.
//
// Covered:
//   • multi-leg crash after leg 2 → resume finishes 3–4 once, 1–2 never re-paid
//   • terminal error on one leg → that leg 'failed', siblings paid, parent pending
//   • ambiguous error on one leg → that leg stays 'pending', re-paid on resume
//   • resume-sweep idempotency (all-completed re-run is a no-op)
//   • a KYC-incomplete recipient leaves its leg pending (parent not completed)
//   • each split's +publication_split ledger entry is gated on the flip (once)
// =============================================================================

const { transfers } = vi.hoisted(() => {
  function makeResource(prefix: string) {
    const calls: Array<{ key?: string; threw: boolean }> = []
    const byKey = new Map<string, { id: string; [k: string]: unknown }>()
    const script: Array<{ throw?: unknown; obj?: Record<string, unknown> }> = []
    let seq = 0
    return {
      calls,
      get distinctKeys() { return byKey.size },
      createCountFor(key: string) { return calls.filter((c) => c.key === key).length },
      succeedNext(obj?: Record<string, unknown>) { script.push({ obj: obj ?? {} }) },
      throwNext(err: unknown) { script.push({ throw: err }) },
      async create(_params: Record<string, unknown>, opts?: { idempotencyKey?: string }) {
        const key = opts?.idempotencyKey
        if (key && byKey.has(key)) { calls.push({ key, threw: false }); return byKey.get(key)! }
        const step = script.shift()
        if (step && 'throw' in step && step.throw !== undefined) { calls.push({ key, threw: true }); throw step.throw }
        seq += 1
        const id = (step?.obj?.id as string) ?? `${prefix}_${seq}`
        const obj = { status: 'paid', ...(step?.obj ?? {}), id }
        calls.push({ key, threw: false })
        if (key) byKey.set(key, obj)
        return obj
      },
      _reset() { calls.length = 0; byKey.clear(); script.length = 0; seq = 0 },
    }
  }
  return { transfers: makeResource('tr') }
})
vi.mock('stripe', () => ({ default: class { transfers = transfers } }))

interface SplitRow {
  id: string
  publication_payout_id: string
  account_id: string
  amount_pence: number
  status: string
  stripe_transfer_id: string | null
}
interface ParentRow { id: string; publication_id: string; status: string; seq: number }
interface ReadRow { id: string; publication_id: string; writer_payout_id: string | null; state: string }
interface AccountRow { id: string; stripe_connect_id: string | null; stripe_connect_kyc_complete: boolean }

const db = {
  accounts: new Map<string, AccountRow>(),
  parents: new Map<string, ParentRow>(),
  splits: [] as SplitRow[],
  reads: [] as ReadRow[],
  ledger: [] as LedgerRow[],
  parentSeq: 0,
  /** Crash on the Nth query matching `re` (1 = the first). */
  crashers: [] as Array<{ re: RegExp; remaining: number }>,
}

function reset() {
  db.accounts.clear()
  db.parents.clear()
  db.splits = []
  db.reads = []
  db.ledger = []
  db.parentSeq = 0
  db.crashers = []
  transfers._reset()
}

/** Seed a reserved parent + one split per member, all KYC-complete by default. */
function seedPayout(
  payoutId: string,
  publicationId: string,
  members: Array<{ account: string; amount: number; kyc?: boolean; connect?: string | null }>,
) {
  db.parentSeq += 1
  db.parents.set(payoutId, { id: payoutId, publication_id: publicationId, status: 'pending', seq: db.parentSeq })
  members.forEach((m, i) => {
    db.accounts.set(m.account, {
      id: m.account,
      stripe_connect_id: m.connect === undefined ? `acct_${m.account}` : m.connect,
      stripe_connect_kyc_complete: m.kyc ?? true,
    })
    db.splits.push({ id: `split-${i + 1}`, publication_payout_id: payoutId, account_id: m.account, amount_pence: m.amount, status: 'pending', stripe_transfer_id: null })
  })
  // One publication read claimed under the parent, so finalise has something to advance.
  db.reads.push({ id: `pread-${payoutId}`, publication_id: publicationId, writer_payout_id: payoutId, state: 'platform_settled' })
}

function crashOn(re: RegExp, occurrence = 1) { db.crashers.push({ re, remaining: occurrence }) }

const ok = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length })

function query(sql: string, params: unknown[] = []) {
  for (const c of db.crashers) {
    if (c.re.test(sql)) {
      c.remaining -= 1
      if (c.remaining === 0) {
        db.crashers.splice(db.crashers.indexOf(c), 1)
        return Promise.reject(new Error('simulated crash'))
      }
    }
  }

  if (/INSERT INTO ledger_entries/.test(sql)) {
    db.ledger.push({ account: params[0] as string, counterparty: (params[1] as string | null) ?? null, amount: Number(params[2]), trigger: String(params[4]), refTable: params[5] as string, refId: params[6] as string })
    return Promise.resolve(ok([{ id: `led-${db.ledger.length}` }]))
  }

  // --- pending splits for a parent (id ASC) ---
  if (/FROM publication_payout_splits\s+WHERE publication_payout_id = \$1\s+AND status = 'pending'\s+AND amount_pence > 0/.test(sql)) {
    const rows = db.splits
      .filter((s) => s.publication_payout_id === params[0] && s.status === 'pending' && s.amount_pence > 0)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => ({ id: s.id, account_id: s.account_id, amount_pence: s.amount_pence }))
    return Promise.resolve(ok(rows))
  }
  // --- per-split account KYC ---
  if (/SELECT stripe_connect_id, stripe_connect_kyc_complete FROM accounts WHERE id = \$1/.test(sql)) {
    const acc = db.accounts.get(params[0] as string)
    return Promise.resolve(ok(acc ? [{ stripe_connect_id: acc.stripe_connect_id, stripe_connect_kyc_complete: acc.stripe_connect_kyc_complete }] : []))
  }
  // --- split completed flip (guarded) ---
  if (/UPDATE publication_payout_splits\s+SET status = 'completed'/.test(sql)) {
    const s = db.splits.find((x) => x.id === params[1])
    if (s && s.status === 'pending') { s.status = 'completed'; s.stripe_transfer_id = params[0] as string; return Promise.resolve({ rows: [], rowCount: 1 }) }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  // --- terminal split fail ---
  if (/UPDATE publication_payout_splits SET status = 'failed'/.test(sql)) {
    const s = db.splits.find((x) => x.id === params[0])
    if (s) s.status = 'failed'
    return Promise.resolve({ rows: [], rowCount: s ? 1 : 0 })
  }

  // --- finalise: advance reads ---
  if (/UPDATE read_events\s+SET state = 'writer_paid'/.test(sql)) {
    const [publicationId, payoutId] = params as [string, string]
    let n = 0
    for (const r of db.reads) if (r.publication_id === publicationId && r.writer_payout_id === payoutId && r.state === 'platform_settled') { r.state = 'writer_paid'; n++ }
    return Promise.resolve({ rows: [], rowCount: n })
  }
  // --- finalise: complete parent only when no non-completed sibling ---
  if (/UPDATE publication_payouts pp\s+SET status = 'completed'/.test(sql)) {
    const p = db.parents.get(params[0] as string)
    const allDone = db.splits.filter((s) => s.publication_payout_id === params[0]).every((s) => s.status === 'completed')
    if (p && p.status === 'pending' && allDone) { p.status = 'completed'; return Promise.resolve({ rows: [], rowCount: 1 }) }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }

  // --- resume: pending parents ---
  if (/FROM publication_payouts\s+WHERE status = 'pending'/.test(sql)) {
    const rows = [...db.parents.values()].filter((p) => p.status === 'pending').sort((a, b) => a.seq - b.seq)
      .map((p) => ({ id: p.id, publication_id: p.publication_id }))
    return Promise.resolve(ok(rows))
  }

  return Promise.resolve({ rows: [], rowCount: 1 })
}

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (sql: string, params: unknown[] = []) => query(sql, params) },
  loadConfig: vi.fn(async () => ({ platformFeeBps: 800 })),
  withTransaction: (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query: (sql: string, params: unknown[] = []) => query(sql, params) }),
}))
vi.mock('@platform-pub/shared/lib/env.js', () => ({ tributesEnabled: () => false }))
vi.mock('../src/lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { payoutService } from '../src/services/payout.js'

const split = (id: string) => db.splits.find((s) => s.id === id)!
const splitEntries = () => db.ledger.filter((e) => e.trigger === 'publication_split')

beforeEach(() => { reset() })

// ---------------------------------------------------------------------------
describe('publication payout — multi-leg crash after leg 2 of 4', () => {
  it('resume completes legs 3–4 exactly once; legs 1–2 never re-paid; parent completes', async () => {
    seedPayout('pp-1', 'pub-1', [
      { account: 'A', amount: 1000 },
      { account: 'B', amount: 2000 },
      { account: 'C', amount: 3000 },
      { account: 'D', amount: 4000 },
    ])
    // Legs 1,2 flip fine; the 3rd split's flip crashes (its transfer already went through).
    crashOn(/UPDATE publication_payout_splits\s+SET status = 'completed'/, 3)
    await payoutService.resumePendingPublicationPayouts()

    expect(split('split-1').status).toBe('completed')
    expect(split('split-2').status).toBe('completed')
    expect(split('split-3').status).toBe('pending') // flip crashed…
    expect(split('split-4').status).toBe('pending') // …loop aborted before leg 4
    expect(transfers.distinctKeys).toBe(3) // legs 1,2,3 transfers created (leg 3's flip crashed)
    expect(db.parents.get('pp-1')!.status).toBe('pending')
    expect(splitEntries()).toHaveLength(2) // only the two flipped legs posted ledger

    // Resume: legs 3–4 finish. Leg 3's transfer dedups on its stable key.
    await payoutService.resumePendingPublicationPayouts()

    expect(db.splits.every((s) => s.status === 'completed')).toBe(true)
    expect(transfers.distinctKeys).toBe(4) // exactly one transfer per recipient
    expect(transfers.createCountFor('pub-split-pp-1-split-1')).toBe(1) // leg 1 NEVER re-attempted
    expect(transfers.createCountFor('pub-split-pp-1-split-2')).toBe(1) // leg 2 NEVER re-attempted
    expect(transfers.createCountFor('pub-split-pp-1-split-3')).toBe(2) // leg 3 retried (deduped)
    expect(splitEntries()).toHaveLength(4) // one ledger entry per recipient
    expect(db.parents.get('pp-1')!.status).toBe('completed')
    expect(db.reads[0].state).toBe('writer_paid') // finalise advanced the reads
  })
})

// ---------------------------------------------------------------------------
describe('publication payout — per-leg terminal vs ambiguous', () => {
  it('terminal on one leg → that leg failed, siblings paid, parent stays pending', async () => {
    seedPayout('pp-1', 'pub-1', [
      { account: 'A', amount: 1000 },
      { account: 'B', amount: 2000 },
    ])
    transfers.throwNext(invalidRequest()) // leg 1 (split-1) terminally rejected
    transfers.succeedNext() // leg 2 pays
    await payoutService.resumePendingPublicationPayouts()

    expect(split('split-1').status).toBe('failed')
    expect(split('split-2').status).toBe('completed')
    expect(db.parents.get('pp-1')!.status).toBe('pending') // a failed sibling blocks completion
    expect(splitEntries()).toHaveLength(1) // only the paid leg
    expect(splitEntries()[0].account).toBe('B')
  })

  it('ambiguous on one leg → that leg stays pending and is re-paid on resume', async () => {
    seedPayout('pp-1', 'pub-1', [
      { account: 'A', amount: 1000 },
      { account: 'B', amount: 2000 },
    ])
    transfers.throwNext(connectionError()) // leg 1 ambiguous → re-thrown, loop aborts
    await payoutService.resumePendingPublicationPayouts()

    expect(split('split-1').status).toBe('pending') // NOT failed — may have gone through
    expect(split('split-2').status).toBe('pending') // never reached (loop aborted)
    expect(db.parents.get('pp-1')!.status).toBe('pending')

    // Resume: both legs pay.
    await payoutService.resumePendingPublicationPayouts()
    expect(db.splits.every((s) => s.status === 'completed')).toBe(true)
    expect(db.parents.get('pp-1')!.status).toBe('completed')
    expect(splitEntries()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
describe('publication payout — resume idempotency & KYC gating', () => {
  it('re-running after all legs completed is a no-op', async () => {
    seedPayout('pp-1', 'pub-1', [{ account: 'A', amount: 1000 }])
    await payoutService.resumePendingPublicationPayouts()
    expect(db.parents.get('pp-1')!.status).toBe('completed')

    await payoutService.resumePendingPublicationPayouts()
    expect(transfers.distinctKeys).toBe(1)
    expect(splitEntries()).toHaveLength(1)
  })

  it('a KYC-incomplete recipient leaves its leg pending and the parent uncompleted', async () => {
    seedPayout('pp-1', 'pub-1', [
      { account: 'A', amount: 1000 },
      { account: 'B', amount: 2000, kyc: false },
    ])
    await payoutService.resumePendingPublicationPayouts()

    expect(split('split-1').status).toBe('completed')
    expect(split('split-2').status).toBe('pending') // skipped — no transfer attempted
    expect(transfers.createCountFor('pub-split-pp-1-split-2')).toBe(0)
    expect(db.parents.get('pp-1')!.status).toBe('pending')
  })

  it('two splits for the SAME account pay under distinct row-stable keys', async () => {
    // A standing member who also holds an article share gets two split rows in
    // one payout. A per-account key made the second create a param-mismatch
    // idempotency collision (wedged pending forever); the row-stable split.id
    // key must pay both legs independently (2026-07-15 audit fix).
    seedPayout('pp-1', 'pub-1', [
      { account: 'A', amount: 1000 },
      { account: 'A', amount: 2500 },
    ])
    await payoutService.resumePendingPublicationPayouts()

    expect(transfers.distinctKeys).toBe(2)
    expect(transfers.createCountFor('pub-split-pp-1-split-1')).toBe(1)
    expect(transfers.createCountFor('pub-split-pp-1-split-2')).toBe(1)
    expect(db.splits.every((s) => s.status === 'completed')).toBe(true)
    expect(db.parents.get('pp-1')!.status).toBe('completed')
    expect(splitEntries()).toHaveLength(2) // one ledger credit per split, both to A
    expect(splitEntries().every((e) => e.account === 'A')).toBe(true)
  })
})
