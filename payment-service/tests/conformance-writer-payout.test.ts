import { describe, it, expect, beforeEach, vi } from 'vitest'
import { connectionError, invalidRequest, type LedgerRow } from './support/conformance.js'

// =============================================================================
// WRITER PAYOUT saga — conformance battery (PAYMENTS ADR §1.1 step 1).
//
// A single-object TRANSFER saga: reserve (Txn 1: lock account, INSERT
// writer_payouts 'pending', claim reads/subs under writer_payout_id) →
// transfers.create (stable key `payout-<id>`) → complete (Txn 2: flip
// 'completed', advance reads to writer_paid, recordLedger +amount gated on the
// flip). Correctness here is CLAIM-ROLLBACK, not column mirroring — payouts move
// no running balance — so the assertions turn on: claimed reads freed on a
// terminal failure, never freed on an ambiguous one, and the +writer_payout
// ledger entry posted exactly once.
//
// Covered:
//   • crash between reserve and the transfer → resume completes exactly once
//   • crash after the transfer, before local complete → resume dedups on the key
//   • terminal transfer error → 'failed' + claimed reads released, no ledger
//   • ambiguous transfer error → NO rollback, reads stay claimed, row 'pending'
//   • resume-sweep idempotency (running the cycle again is a no-op)
//   • the +writer_payout ledger entry is gated on the flip (never posted twice)
// =============================================================================

const { transfers } = vi.hoisted(() => {
  function makeResource(prefix: string) {
    const calls: Array<{ key?: string; threw: boolean }> = []
    const byKey = new Map<string, { id: string; [k: string]: unknown }>()
    const byId = new Map<string, { id: string; [k: string]: unknown }>()
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
        byId.set(id, obj)
        return obj
      },
      _reset() { calls.length = 0; byKey.clear(); byId.clear(); script.length = 0; seq = 0 },
    }
  }
  return { transfers: makeResource('tr') }
})
vi.mock('stripe', () => ({ default: class { transfers = transfers } }))

const FEE_BPS = 800
const netOf = (amount: number) => amount - Math.floor((amount * FEE_BPS) / 10_000)

interface ReadRow {
  id: string
  writer_id: string
  state: string
  writer_payout_id: string | null
  publication_id: string | null
  amount_pence: number
}
interface PayoutRow {
  id: string
  writer_id: string
  amount_pence: number
  status: string
  stripe_transfer_id: string | null
  failed_reason: string | null
  seq: number
}
interface AccountRow { id: string; stripe_connect_id: string | null; stripe_connect_kyc_complete: boolean }

const db = {
  accounts: new Map<string, AccountRow>(),
  payouts: new Map<string, PayoutRow>(),
  reads: [] as ReadRow[],
  ledger: [] as LedgerRow[],
  seq: 0,
  crashers: [] as RegExp[],
}

function reset() {
  db.accounts.clear()
  db.payouts.clear()
  db.reads = []
  db.ledger = []
  db.seq = 0
  db.crashers = []
  transfers._reset()
}

function seedWriter(writerId: string, opts: { reads: number[]; kyc?: boolean; connect?: string | null }) {
  db.accounts.set(writerId, {
    id: writerId,
    stripe_connect_id: opts.connect === undefined ? `acct_${writerId}` : opts.connect,
    stripe_connect_kyc_complete: opts.kyc ?? true,
  })
  opts.reads.forEach((amount, i) => {
    db.reads.push({
      id: `read-${writerId}-${i}`,
      writer_id: writerId,
      state: 'platform_settled',
      writer_payout_id: null,
      publication_id: null,
      amount_pence: amount,
    })
  })
}

function crashOn(re: RegExp) { db.crashers.push(re) }

const ok = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length })

/** Unclaimed, settled, non-publication reads for a writer. */
const unclaimed = (writerId: string) =>
  db.reads.filter((r) => r.writer_id === writerId && r.state === 'platform_settled' && r.writer_payout_id === null && r.publication_id === null)

function query(sql: string, params: unknown[] = []) {
  for (let i = 0; i < db.crashers.length; i++) {
    if (db.crashers[i].test(sql)) { db.crashers.splice(i, 1); return Promise.reject(new Error('simulated crash')) }
  }

  if (/INSERT INTO ledger_entries/.test(sql)) {
    db.ledger.push({ account: params[0] as string, counterparty: (params[1] as string | null) ?? null, amount: Number(params[2]), trigger: String(params[4]), refTable: params[5] as string, refId: params[6] as string })
    return Promise.resolve(ok([{ id: `led-${db.ledger.length}` }]))
  }

  // --- eligibility CTE ---
  if (/WITH base AS/.test(sql) && /FROM read_events/.test(sql) && /state = 'platform_settled'/.test(sql)) {
    const byWriter = new Map<string, number>()
    for (const r of db.reads) {
      if (r.state === 'platform_settled' && r.writer_payout_id === null && r.publication_id === null) {
        byWriter.set(r.writer_id, (byWriter.get(r.writer_id) ?? 0) + r.amount_pence)
      }
    }
    const rows: Record<string, unknown>[] = []
    for (const [writerId, gross] of byWriter) {
      const acc = db.accounts.get(writerId)
      const net = unclaimed(writerId).reduce((s, r) => s + netOf(r.amount_pence), 0)
      if (acc?.stripe_connect_kyc_complete && acc.stripe_connect_id && net >= 2000) {
        rows.push({ writer_id: writerId, gross_pence: String(gross), net_pence: String(net), stripe_connect_id: acc.stripe_connect_id })
      }
    }
    return Promise.resolve(ok(rows))
  }

  // --- account lock ---
  if (/SELECT id FROM accounts WHERE id = \$1 FOR UPDATE/.test(sql)) {
    const acc = db.accounts.get(params[0] as string)
    return Promise.resolve(ok(acc ? [{ id: acc.id }] : []))
  }

  // --- reserve INSERT ---
  if (/INSERT INTO writer_payouts/.test(sql)) {
    db.seq += 1
    const id = `wp-${db.seq}`
    db.payouts.set(id, { id, writer_id: params[0] as string, amount_pence: 0, status: 'pending', stripe_transfer_id: null, failed_reason: null, seq: db.seq })
    return Promise.resolve(ok([{ id }]))
  }

  // --- claim reads ---
  if (/UPDATE read_events\s+SET writer_payout_id = \$1/.test(sql) && /RETURNING/.test(sql)) {
    const payoutId = params[0] as string
    const writerId = params[1] as string
    const claimed = unclaimed(writerId)
    claimed.forEach((r) => { r.writer_payout_id = payoutId })
    return Promise.resolve(ok(claimed.map((r) => ({ net_pence: String(netOf(r.amount_pence)) }))))
  }
  // --- claim subs (none) ---
  if (/UPDATE subscription_events\s+SET writer_payout_id = \$1/.test(sql) && /RETURNING/.test(sql)) {
    return Promise.resolve(ok([]))
  }
  // --- carve on claimed set → 0 (tributes dark) ---
  if (/AS carve_pence/.test(sql)) {
    return Promise.resolve(ok([{ carve_pence: '0' }]))
  }
  // --- peek net ---
  if (/AS net_pence/.test(sql)) {
    const writerId = params[0] as string
    const net = unclaimed(writerId).reduce((s, r) => s + netOf(r.amount_pence), 0)
    return Promise.resolve(ok([{ net_pence: String(net) }]))
  }
  // --- patch amount ---
  if (/UPDATE writer_payouts SET amount_pence = \$1/.test(sql)) {
    const p = db.payouts.get(params[1] as string)
    if (p) p.amount_pence = Number(params[0])
    return Promise.resolve({ rows: [], rowCount: p ? 1 : 0 })
  }

  // --- completion flip (guarded pending → completed) ---
  if (/UPDATE writer_payouts\s+SET status = 'completed'/.test(sql)) {
    const p = db.payouts.get(params[1] as string)
    if (p && p.status === 'pending') {
      p.status = 'completed'
      p.stripe_transfer_id = params[0] as string
      return Promise.resolve({ rows: [], rowCount: 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  // --- advance reads to writer_paid ---
  if (/UPDATE read_events\s+SET state = 'writer_paid'/.test(sql)) {
    const payoutId = params[0] as string
    let n = 0
    for (const r of db.reads) if (r.writer_payout_id === payoutId && r.state === 'platform_settled') { r.state = 'writer_paid'; n++ }
    return Promise.resolve({ rows: [], rowCount: n })
  }

  // --- terminal failure flip (guarded pending → failed) ---
  if (/UPDATE writer_payouts\s+SET status = 'failed'/.test(sql)) {
    const p = db.payouts.get(params[1] as string)
    if (p && p.status === 'pending') {
      p.status = 'failed'
      p.failed_reason = (params[0] as string) ?? p.failed_reason
      return Promise.resolve(ok([{ id: p.id, writer_id: p.writer_id }]))
    }
    return Promise.resolve(ok([]))
  }
  // --- rollback claimed reads ---
  if (/UPDATE read_events\s+SET state = 'platform_settled',\s+writer_payout_id = NULL/.test(sql)) {
    const payoutId = params[0] as string
    let n = 0
    for (const r of db.reads) if (r.writer_payout_id === payoutId) { r.state = 'platform_settled'; r.writer_payout_id = null; n++ }
    return Promise.resolve({ rows: [], rowCount: n })
  }
  if (/UPDATE subscription_events\s+SET writer_payout_id = NULL/.test(sql)) {
    return Promise.resolve({ rows: [], rowCount: 0 })
  }

  // --- resume pending list ---
  if (/FROM writer_payouts\s+WHERE status = 'pending'/.test(sql)) {
    const rows = [...db.payouts.values()].filter((p) => p.status === 'pending').sort((a, b) => a.seq - b.seq)
      .map((p) => ({ id: p.id, writer_id: p.writer_id, amount_pence: p.amount_pence, stripe_connect_id: db.accounts.get(p.writer_id)?.stripe_connect_id ?? null }))
    return Promise.resolve(ok(rows))
  }

  return Promise.resolve({ rows: [], rowCount: 1 })
}

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (sql: string, params: unknown[] = []) => query(sql, params) },
  loadConfig: vi.fn(async () => ({ platformFeeBps: 800, writerPayoutThresholdPence: 2000 })),
  withTransaction: (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query: (sql: string, params: unknown[] = []) => query(sql, params) }),
}))
vi.mock('@platform-pub/shared/lib/env.js', () => ({ tributesEnabled: () => false }))
vi.mock('../src/lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { payoutService } from '../src/services/payout.js'

const onlyPayout = () => [...db.payouts.values()][0]
const writerPayoutEntries = () => db.ledger.filter((e) => e.trigger === 'writer_payout')

beforeEach(() => { reset() })

// ---------------------------------------------------------------------------
describe('writer payout — crash & resume (exactly once)', () => {
  it('crash between reserve and the transfer → resume completes exactly once', async () => {
    seedWriter('writer-1', { reads: [5000] })
    transfers.throwNext(connectionError()) // transfer fails ambiguously during the cycle
    await payoutService.runPayoutCycle() // per-writer error is swallowed; row left pending

    expect(onlyPayout().status).toBe('pending')
    expect(db.reads[0].writer_payout_id).toBe(onlyPayout().id) // reads stay claimed
    expect(writerPayoutEntries()).toHaveLength(0)
    expect(transfers.distinctKeys).toBe(0)

    // Next cycle resumes the pending row (eligibility now finds nothing — reads claimed).
    transfers.succeedNext()
    await payoutService.runPayoutCycle()

    expect(onlyPayout().status).toBe('completed')
    expect(db.payouts.size).toBe(1) // no second payout row
    expect(transfers.distinctKeys).toBe(1) // exactly one transfer
    expect(writerPayoutEntries()).toHaveLength(1)
    expect(writerPayoutEntries()[0].amount).toBe(netOf(5000))
  })

  it('crash after the transfer, before local complete → resume dedups, no second transfer', async () => {
    seedWriter('writer-1', { reads: [5000] })
    // The transfer SUCCEEDS, then the completion flip "crashes".
    crashOn(/UPDATE writer_payouts\s+SET status = 'completed'/)
    await payoutService.runPayoutCycle()

    expect(onlyPayout().status).toBe('pending')
    expect(transfers.distinctKeys).toBe(1) // transfer DID go through
    expect(writerPayoutEntries()).toHaveLength(0) // ledger gated on the flip, which crashed

    await payoutService.runPayoutCycle() // resume: same key replays the transfer

    expect(onlyPayout().status).toBe('completed')
    expect(transfers.distinctKeys).toBe(1) // still exactly one transfer
    expect(writerPayoutEntries()).toHaveLength(1) // posted once, on the successful flip
  })
})

// ---------------------------------------------------------------------------
describe('writer payout — terminal vs ambiguous', () => {
  it('terminal transfer error → failed, claimed reads released, no ledger', async () => {
    seedWriter('writer-1', { reads: [5000] })
    transfers.throwNext(invalidRequest()) // StripeInvalidRequestError — terminal for a transfer
    await payoutService.runPayoutCycle()

    expect(onlyPayout().status).toBe('failed')
    // Claim rolled back: the read is free for the next cycle to re-pay under a new id.
    expect(db.reads[0].writer_payout_id).toBeNull()
    expect(db.reads[0].state).toBe('platform_settled')
    expect(writerPayoutEntries()).toHaveLength(0)
  })

  it('ambiguous transfer error → NO rollback, reads stay claimed, row pending', async () => {
    seedWriter('writer-1', { reads: [5000] })
    transfers.throwNext(connectionError()) // may have gone through — must NOT roll back
    await payoutService.runPayoutCycle()

    expect(onlyPayout().status).toBe('pending')
    expect(db.reads[0].writer_payout_id).toBe(onlyPayout().id) // still claimed (no double-pay)
    expect(db.reads[0].state).toBe('platform_settled')
    expect(writerPayoutEntries()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
describe('writer payout — resume-sweep idempotency & ledger-once', () => {
  it('re-running the cycle after completion is a no-op (no extra transfer or ledger)', async () => {
    seedWriter('writer-1', { reads: [5000] })
    transfers.succeedNext()
    await payoutService.runPayoutCycle()
    expect(onlyPayout().status).toBe('completed')

    await payoutService.runPayoutCycle()
    await payoutService.runPayoutCycle()

    expect(transfers.distinctKeys).toBe(1) // no extra transfers
    expect(writerPayoutEntries()).toHaveLength(1) // ledger posted exactly once
    expect(db.payouts.size).toBe(1)
  })

  it('below-threshold earnings are not paid out', async () => {
    seedWriter('writer-1', { reads: [1000] }) // net 920 < 2000 threshold
    await payoutService.runPayoutCycle()
    expect(db.payouts.size).toBe(0)
    expect(transfers.calls).toHaveLength(0)
  })

  it('a writer without completed KYC is skipped', async () => {
    seedWriter('writer-1', { reads: [5000], kyc: false })
    await payoutService.runPayoutCycle()
    expect(db.payouts.size).toBe(0)
    expect(transfers.calls).toHaveLength(0)
  })
})
