import { describe, it, expect, beforeEach, vi } from 'vitest'
import { connectionError, invalidRequest, type LedgerRow } from './support/conformance.js'

// =============================================================================
// TRIBUTE PAYOUT saga — conformance battery, POST-DIAL-A shape (PAYMENTS ADR
// §1.1 step 1; the flow's final shape after migration 156 deleted the
// held/swept/returned machinery — accruals are only ever released → paid).
//
// A transfer saga gated behind tributesEnabled() (mocked TRUE here). reserve
// (Txn 1: lock tribute, INSERT tribute_payouts 'pending', claim released accruals
// under tribute_payout_id) → transfers.create (stable key `tribute-payout-<id>`)
// → complete (Txn 2: flip 'completed', accruals released→paid, post TWO ledger
// entries — the inspirer's `tribute_payout` (+amount, cp = author) and, ROOT
// tributes ONLY, the author's `tribute_carve` (−carve, cp = inspirer)).
//
// Covered:
//   • crash between reserve and the transfer → resume completes exactly once
//   • crash after the transfer, before local complete → resume dedups on the key
//   • terminal transfer error → 'failed' + claimed accruals released, no ledger
//   • ambiguous transfer error → NO rollback, accruals stay claimed, row pending
//   • resume-sweep idempotency (carve + payout entries posted exactly once)
//   • a CHILD tribute posts only the inspirer payout, never an author carve
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

interface TributeRow { id: string; inspirer: string; author: string; parent: string | null; status: string }
interface AccrualRow { id: string; tribute_id: string; amount_pence: number; state: string; tribute_payout_id: string | null; read_state: string }
interface PayoutRow { id: string; tribute_id: string; inspirer: string; author: string; amount_pence: number; status: string; stripe_transfer_id: string | null; seq: number }
interface AccountRow { id: string; stripe_connect_id: string | null; stripe_connect_kyc_complete: boolean }

const db = {
  accounts: new Map<string, AccountRow>(),
  tributes: new Map<string, TributeRow>(),
  accruals: [] as AccrualRow[],
  payouts: new Map<string, PayoutRow>(),
  ledger: [] as LedgerRow[],
  seq: 0,
  crashers: [] as RegExp[],
}

function reset() {
  db.accounts.clear()
  db.tributes.clear()
  db.accruals = []
  db.payouts.clear()
  db.ledger = []
  db.seq = 0
  db.crashers = []
  transfers._reset()
}

function ensureAccount(id: string, kyc = true, connect: string | null | undefined = undefined) {
  db.accounts.set(id, { id, stripe_connect_id: connect === undefined ? `acct_${id}` : connect, stripe_connect_kyc_complete: kyc })
}

/** Seed a tribute + its inspirer account + released accruals. */
function seedTribute(
  id: string,
  opts: { inspirer: string; author: string; parent?: string | null; accruals: number[]; kyc?: boolean; connect?: string | null },
) {
  db.tributes.set(id, { id, inspirer: opts.inspirer, author: opts.author, parent: opts.parent ?? null, status: 'live' })
  ensureAccount(opts.inspirer, opts.kyc ?? true, opts.connect)
  opts.accruals.forEach((amount, i) => {
    db.accruals.push({ id: `acc-${id}-${i}`, tribute_id: id, amount_pence: amount, state: 'released', tribute_payout_id: null, read_state: 'platform_settled' })
  })
}

function crashOn(re: RegExp) { db.crashers.push(re) }

const ok = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length })

const releasedUnclaimed = (tributeId: string) =>
  db.accruals.filter((a) => a.tribute_id === tributeId && a.state === 'released' && a.tribute_payout_id === null)

function query(sql: string, params: unknown[] = []) {
  for (let i = 0; i < db.crashers.length; i++) {
    if (db.crashers[i].test(sql)) { db.crashers.splice(i, 1); return Promise.reject(new Error('simulated crash')) }
  }

  if (/INSERT INTO ledger_entries/.test(sql)) {
    db.ledger.push({ account: params[0] as string, counterparty: (params[1] as string | null) ?? null, amount: Number(params[2]), trigger: String(params[4]), refTable: params[5] as string, refId: params[6] as string })
    return Promise.resolve(ok([{ id: `led-${db.ledger.length}` }]))
  }

  // --- eligibility ---
  if (/WITH candidates AS/.test(sql) && /FROM tribute_accruals/.test(sql)) {
    const rows: Record<string, unknown>[] = []
    for (const t of db.tributes.values()) {
      if (t.status !== 'live') continue
      if (releasedUnclaimed(t.id).length === 0) continue
      const insp = db.accounts.get(t.inspirer)
      if (insp?.stripe_connect_kyc_complete && insp.stripe_connect_id) {
        rows.push({ tribute_id: t.id, inspirer_account_id: t.inspirer, author_account_id: t.author, stripe_connect_id: insp.stripe_connect_id })
      }
    }
    return Promise.resolve(ok(rows))
  }

  // --- tribute lock ---
  if (/SELECT id FROM tributes WHERE id = \$1 FOR UPDATE/.test(sql)) {
    const t = db.tributes.get(params[0] as string)
    return Promise.resolve(ok(t ? [{ id: t.id }] : []))
  }
  // --- reserve net (gross_released − child_carve; no nested chains seeded → carve 0) ---
  if (/AS gross_released/.test(sql)) {
    const gross = releasedUnclaimed(params[0] as string).reduce((s, a) => s + a.amount_pence, 0)
    return Promise.resolve(ok([{ gross_released: String(gross), child_carve: '0' }]))
  }
  // --- reserve INSERT ---
  if (/INSERT INTO tribute_payouts/.test(sql)) {
    db.seq += 1
    const id = `tp-${db.seq}`
    db.payouts.set(id, { id, tribute_id: params[0] as string, inspirer: params[1] as string, author: params[2] as string, amount_pence: Number(params[3]), status: 'pending', stripe_transfer_id: null, seq: db.seq })
    return Promise.resolve(ok([{ id }]))
  }
  // --- claim accruals (reserve) ---
  if (/UPDATE tribute_accruals\s+SET tribute_payout_id = \$1/.test(sql)) {
    const [payoutId, tributeId] = params as [string, string]
    for (const a of releasedUnclaimed(tributeId)) a.tribute_payout_id = payoutId
    return Promise.resolve({ rows: [], rowCount: 1 })
  }

  // --- completion flip (guarded) ---
  if (/UPDATE tribute_payouts\s+SET status = 'completed'/.test(sql)) {
    const p = db.payouts.get(params[1] as string)
    if (p && p.status === 'pending') { p.status = 'completed'; p.stripe_transfer_id = params[0] as string; return Promise.resolve({ rows: [], rowCount: 1 }) }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  // --- advance accruals released→paid (RETURNING amount_pence) ---
  if (/UPDATE tribute_accruals\s+SET state = 'paid'/.test(sql)) {
    const payoutId = params[0] as string
    const advanced = db.accruals.filter((a) => a.tribute_payout_id === payoutId && a.state === 'released')
    advanced.forEach((a) => { a.state = 'paid' })
    return Promise.resolve(ok(advanced.map((a) => ({ amount_pence: String(a.amount_pence) }))))
  }
  // --- rollback: payout-row lookup for the balancing carve (param = payoutId;
  //     must precede the generic is_root check, whose text this SQL contains) ---
  if (/FROM tribute_payouts tp\s+JOIN tributes t/.test(sql)) {
    const p = db.payouts.get(params[0] as string)
    const t = p ? db.tributes.get(p.tribute_id) : undefined
    return Promise.resolve(
      ok(p && t ? [{ inspirer_account_id: p.inspirer, author_account_id: p.author, is_root: t.parent === null }] : []),
    )
  }
  // --- is_root check ---
  if (/parent_tribute_id IS NULL AS is_root/.test(sql)) {
    const t = db.tributes.get(params[0] as string)
    return Promise.resolve(ok([{ is_root: t ? t.parent === null : false }]))
  }

  // --- terminal fail flip (guarded) ---
  if (/UPDATE tribute_payouts\s+SET status = 'failed'/.test(sql)) {
    const p = db.payouts.get(params[1] as string)
    if (p && p.status === 'pending') { p.status = 'failed'; return Promise.resolve(ok([{ id: p.id }])) }
    return Promise.resolve(ok([]))
  }
  // --- rollback: void chargeback-reversed claims (RETURNING amount_pence) ---
  if (/UPDATE tribute_accruals ta\s+SET state = 'voided'/.test(sql)) {
    const payoutId = params[0] as string
    const voided = db.accruals.filter(
      (a) => a.tribute_payout_id === payoutId && a.state === 'released' && a.read_state === 'charged_back',
    )
    voided.forEach((a) => { a.state = 'voided'; a.tribute_payout_id = null })
    return Promise.resolve(ok(voided.map((a) => ({ amount_pence: String(a.amount_pence) }))))
  }
  // --- rollback accruals (state-filtered: released only) ---
  if (/UPDATE tribute_accruals\s+SET state = 'released', tribute_payout_id = NULL/.test(sql)) {
    const payoutId = params[0] as string
    let n = 0
    for (const a of db.accruals) if (a.tribute_payout_id === payoutId && a.state === 'released') { a.tribute_payout_id = null; n++ }
    return Promise.resolve({ rows: [], rowCount: n })
  }

  // --- resume pending list ---
  if (/FROM tribute_payouts\s+WHERE status = 'pending'/.test(sql)) {
    const rows = [...db.payouts.values()].filter((p) => p.status === 'pending').sort((a, b) => a.seq - b.seq)
      .map((p) => ({ id: p.id, tribute_id: p.tribute_id, inspirer_account_id: p.inspirer, author_account_id: p.author, amount_pence: p.amount_pence }))
    return Promise.resolve(ok(rows))
  }
  // --- resume inspirer account lookup ---
  if (/SELECT stripe_connect_id, stripe_connect_kyc_complete FROM accounts WHERE id = \$1/.test(sql)) {
    const acc = db.accounts.get(params[0] as string)
    return Promise.resolve(ok(acc ? [{ stripe_connect_id: acc.stripe_connect_id, stripe_connect_kyc_complete: acc.stripe_connect_kyc_complete }] : []))
  }

  return Promise.resolve({ rows: [], rowCount: 1 })
}

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (sql: string, params: unknown[] = []) => query(sql, params) },
  loadConfig: vi.fn(async () => ({ platformFeeBps: 800 })),
  withTransaction: (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query: (sql: string, params: unknown[] = []) => query(sql, params) }),
}))
vi.mock('@platform-pub/shared/lib/env.js', () => ({ tributesEnabled: () => true }))
vi.mock('../src/lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { payoutService } from '../src/services/payout.js'

const onlyPayout = () => [...db.payouts.values()][0]
const entries = (trigger: string) => db.ledger.filter((e) => e.trigger === trigger)

beforeEach(() => { reset() })

// A root tribute: author W, inspirer I1, one released accrual of 300.
function seedRoot() { seedTribute('T1', { inspirer: 'I1', author: 'W', parent: null, accruals: [300] }) }

// ---------------------------------------------------------------------------
describe('tribute payout — crash & resume (exactly once)', () => {
  it('crash between reserve and the transfer → resume completes exactly once', async () => {
    seedRoot()
    transfers.throwNext(connectionError())
    await payoutService.runTributePayoutCycle() // per-tribute error swallowed; row pending

    expect(onlyPayout().status).toBe('pending')
    expect(db.accruals[0].tribute_payout_id).toBe(onlyPayout().id) // claimed…
    expect(db.accruals[0].state).toBe('released') // …but not yet paid
    expect(db.ledger).toHaveLength(0)

    transfers.succeedNext()
    await payoutService.runTributePayoutCycle()

    expect(onlyPayout().status).toBe('completed')
    expect(db.payouts.size).toBe(1)
    expect(transfers.distinctKeys).toBe(1)
    expect(db.accruals[0].state).toBe('paid')
    expect(entries('tribute_payout')).toHaveLength(1)
    expect(entries('tribute_carve')).toHaveLength(1) // root → carve posted
  })

  it('crash after the transfer, before local complete → resume dedups, no second transfer', async () => {
    seedRoot()
    crashOn(/UPDATE tribute_payouts\s+SET status = 'completed'/)
    await payoutService.runTributePayoutCycle()

    expect(onlyPayout().status).toBe('pending')
    expect(transfers.distinctKeys).toBe(1) // transfer went through
    expect(db.ledger).toHaveLength(0) // ledger gated on the flip, which crashed

    await payoutService.runTributePayoutCycle() // resume dedups the transfer

    expect(onlyPayout().status).toBe('completed')
    expect(transfers.distinctKeys).toBe(1)
    expect(entries('tribute_payout')).toHaveLength(1)
    expect(entries('tribute_carve')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
describe('tribute payout — terminal vs ambiguous', () => {
  it('terminal transfer error → failed, claimed accruals released, no ledger', async () => {
    seedRoot()
    transfers.throwNext(invalidRequest())
    await payoutService.runTributePayoutCycle()

    expect(onlyPayout().status).toBe('failed')
    expect(db.accruals[0].tribute_payout_id).toBeNull() // released for re-pay
    expect(db.accruals[0].state).toBe('released')
    expect(db.ledger).toHaveLength(0)
  })

  it('terminal failure of a chargeback-reversed claim → accrual VOIDED + balancing author carve', async () => {
    // The read charged back while the payout was in flight: the chargeback
    // planner reversed as-if-paid (tribute_carve_reversal +300 on the author,
    // premised on this payout completing and posting the forward −300 carve).
    // A terminal failure means completion never runs — the rollback must void
    // the accrual (never re-pay clawed-back money) AND post the balancing
    // tribute_carve, else the author's ledger_writer_earned stays inflated by
    // +root_gross forever (correct earned delta for a clawed-back read is 0).
    seedRoot()
    db.accruals[0].read_state = 'charged_back'
    transfers.throwNext(invalidRequest())
    await payoutService.runTributePayoutCycle()

    expect(onlyPayout().status).toBe('failed')
    expect(db.accruals[0].state).toBe('voided') // terminal — never re-claimed
    expect(db.accruals[0].tribute_payout_id).toBeNull()
    expect(entries('tribute_carve')).toEqual([
      expect.objectContaining({ account: 'W', counterparty: 'I1', amount: -300 }),
    ])
    expect(entries('tribute_payout')).toHaveLength(0) // paid side untouched (M3 residual)
  })

  it('ambiguous transfer error → NO rollback, accruals stay claimed, row pending', async () => {
    seedRoot()
    transfers.throwNext(connectionError())
    await payoutService.runTributePayoutCycle()

    expect(onlyPayout().status).toBe('pending')
    expect(db.accruals[0].tribute_payout_id).toBe(onlyPayout().id) // still claimed (no double-pay)
    expect(db.accruals[0].state).toBe('released')
    expect(db.ledger).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
describe('tribute payout — ledger shape & idempotency', () => {
  it('a ROOT tribute posts the inspirer payout (+) and the author carve (−)', async () => {
    seedRoot()
    transfers.succeedNext()
    await payoutService.runTributePayoutCycle()

    const payout = entries('tribute_payout')[0]
    expect(payout).toMatchObject({ account: 'I1', counterparty: 'W', amount: 300 })
    const carve = entries('tribute_carve')[0]
    expect(carve).toMatchObject({ account: 'W', counterparty: 'I1', amount: -300 }) // debits the author
  })

  it('a CHILD tribute posts only the inspirer payout — never an author carve', async () => {
    // T2 is a chained node (parent T1): its onward carve reduces the PARENT
    // inspirer's share, so it must NOT debit the article author's earned.
    seedTribute('T2', { inspirer: 'I2', author: 'I1', parent: 'T1', accruals: [100] })
    transfers.succeedNext()
    await payoutService.runTributePayoutCycle()

    expect(entries('tribute_payout')[0]).toMatchObject({ account: 'I2', counterparty: 'I1', amount: 100 })
    expect(entries('tribute_carve')).toHaveLength(0) // no carve for a non-root
  })

  it('re-running the cycle after completion posts nothing more', async () => {
    seedRoot()
    transfers.succeedNext()
    await payoutService.runTributePayoutCycle()
    await payoutService.runTributePayoutCycle()
    await payoutService.runTributePayoutCycle()

    expect(transfers.distinctKeys).toBe(1)
    expect(entries('tribute_payout')).toHaveLength(1)
    expect(entries('tribute_carve')).toHaveLength(1) // carve posted exactly once
  })
})
