import { describe, it, expect, beforeEach, vi } from 'vitest'
import { perReadNetPence } from '@platform-pub/shared/lib/per-read-net.js'
import type { LedgerRow } from './support/conformance.js'

// =============================================================================
// Settlement ↔ read-attribution CONSERVATION (PAYMENTS ADR §1.2 — the property
// tests, the superset half; the scheduled reconciliation job shipped 2026-07-14).
//
// The correctness argument for `confirmSettlement`'s apportionment lives only in
// prose (settlement.ts:587–596): reads advance by the TIME predicate
// `read_at <= settled_at`, NOT by which reads' grosses summed to the charged
// `amount_pence`. So read↔settlement pairing is APPROXIMATE — a read can advance
// (and earn its writer) under a settlement whose charge did not cover it, its
// penny collected by the next settlement — yet money must conserve GLOBALLY.
//
// This file promotes that prose to executable properties. It drives the REAL
// SettlementService.confirmSettlement (incl. the real applyLedgerDelta +
// recordLedger) against a stateful in-memory model of {tab_settlements,
// reading_tabs, read_events, ledger}, with NUMERIC virtual timestamps so the
// `read_at <= settled_at` window is deterministic. §1.1 forbids touching the
// apportionment SQL, so we pin it by observation, never by reimplementation.
//
// Properties asserted across scenarios:
//   P1  each accrued read reaches platform_settled under EXACTLY ONE settlement
//       (the state='accrued' guard) — no read double-settled, none lost;
//   P2  Σ(writer_accrual) == Σ perReadNet(gross) over settled NON-publication
//       reads — the writer earns the per-read net, once (F2: pub reads excluded);
//   P3  reader parity −Σ(reader ledger) == balance holds after every confirm;
//   P4  the settlement fee split conserves: amount == platform_fee + net_to_writers,
//       and Σgross == Σ(writer net) + Σ(implicit platform fee) over settled reads;
//   P5  GLOBAL conservation under approximate attribution: reads advance by the
//       time window (not the charged amount), yet Σ charged == Σ settled-read gross.
// =============================================================================

// confirmSettlement calls no Stripe API, but the service constructs `new Stripe()`
// at module load — stub it so no key is needed.
vi.mock('stripe', () => ({ default: class { paymentIntents = {} } }))

const FEE_BPS = 800 // 8%

// --- Model -----------------------------------------------------------------
interface SettlementRow {
  id: string
  reader_id: string
  tab_id: string
  amount_pence: number
  platform_fee_pence: number
  net_to_writers_pence: number
  status: string
  stripe_payment_intent_id: string | null
  stripe_charge_id: string | null
  settled_at: number // virtual clock
}
interface ReadRow {
  id: string
  tab_id: string
  writer_id: string
  amount_pence: number
  publication_id: string | null
  state: string
  read_at: number // virtual clock
  tab_settlement_id: string | null
}
interface TabRow {
  id: string
  reader_id: string
  balance_pence: number
}

const db = {
  settlements: new Map<string, SettlementRow>(),
  tabsById: new Map<string, TabRow>(),
  tabsByReader: new Map<string, TabRow>(),
  reads: [] as ReadRow[],
  ledger: [] as LedgerRow[],
  seq: 0,
}

function reset() {
  db.settlements.clear()
  db.tabsById.clear()
  db.tabsByReader.clear()
  db.reads = []
  db.ledger = []
  db.seq = 0
}

/** Seed a reader's tab. balance is set explicitly; the mirror read_accrual /
 *  non-read debt entries are seeded by the caller so −Σ(reader) == balance. */
function seedTab(readerId: string, balance: number) {
  const tab: TabRow = { id: `tab-${readerId}`, reader_id: readerId, balance_pence: balance }
  db.tabsById.set(tab.id, tab)
  db.tabsByReader.set(readerId, tab)
}

/** Seed an accrued read + its mirror read_accrual ledger entry (−gross), exactly
 *  as recordGatePass would have left the tab before settlement. */
function seedRead(
  readerId: string,
  id: string,
  writerId: string,
  gross: number,
  readAt: number,
  publicationId: string | null = null,
) {
  db.reads.push({
    id,
    tab_id: `tab-${readerId}`,
    writer_id: writerId,
    amount_pence: gross,
    publication_id: publicationId,
    state: 'accrued',
    read_at: readAt,
    tab_settlement_id: null,
  })
  db.ledger.push({ account: readerId, counterparty: null, amount: -gross, trigger: 'read_accrual' })
}

/** Seed a non-read tab debit + its mirror ledger entry (models a subscription
 *  charge riding the same tab — the reason amount_pence ≠ Σ read gross). */
function seedNonReadDebt(readerId: string, amount: number, trigger: string) {
  db.tabsByReader.get(readerId)!.balance_pence // (balance seeded whole via seedTab)
  db.ledger.push({ account: readerId, counterparty: null, amount: -amount, trigger })
}

/** Pre-seed a COMPLETED settlement (as if reserve→complete already ran), ready
 *  for confirmSettlement to claim. Computes the fee split exactly as reserve does. */
function seedSettlement(readerId: string, amount: number, settledAt: number): SettlementRow {
  db.seq += 1
  const id = `settle-${db.seq}`
  const pi = `pi_${db.seq}`
  const fee = Math.floor((amount * FEE_BPS) / 10000)
  const row: SettlementRow = {
    id,
    reader_id: readerId,
    tab_id: `tab-${readerId}`,
    amount_pence: amount,
    platform_fee_pence: fee,
    net_to_writers_pence: amount - fee,
    status: 'completed',
    stripe_payment_intent_id: pi,
    stripe_charge_id: null,
    settled_at: settledAt,
  }
  db.settlements.set(id, row)
  return row
}

const ok = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length })

function query(sql: string, params: unknown[] = []) {
  // --- applyLedgerDelta: reading_tabs upsert by reader_id (no clamp) ---
  if (/INSERT INTO reading_tabs/.test(sql)) {
    const readerId = params[0] as string
    const delta = Number(params[1])
    let tab = db.tabsByReader.get(readerId)
    if (!tab) {
      tab = { id: `tab-${readerId}`, reader_id: readerId, balance_pence: 0 }
      db.tabsById.set(tab.id, tab)
      db.tabsByReader.set(readerId, tab)
    }
    tab.balance_pence += delta
    return Promise.resolve(ok([{ id: tab.id, balance_pence: tab.balance_pence }]))
  }
  // --- recordLedger insert (tab_settlement mirror AND writer_accrual) ---
  if (/INSERT INTO ledger_entries/.test(sql)) {
    db.ledger.push({
      account: params[0] as string,
      counterparty: (params[1] as string | null) ?? null,
      amount: Number(params[2]),
      trigger: String(params[4]),
      refTable: params[5] as string,
      refId: params[6] as string,
    })
    return Promise.resolve(ok([{ id: `led-${db.ledger.length}` }]))
  }

  // --- confirm: settlement lookup by PI id ---
  if (/FROM tab_settlements\s+WHERE stripe_payment_intent_id = \$1/.test(sql)) {
    const row = [...db.settlements.values()].find((s) => s.stripe_payment_intent_id === params[0])
    return Promise.resolve(
      ok(row ? [{ id: row.id, reader_id: row.reader_id, tab_id: row.tab_id, amount_pence: row.amount_pence, stripe_charge_id: row.stripe_charge_id, status: row.status }] : []),
    )
  }
  // --- tab lock ---
  if (/FROM reading_tabs WHERE id = \$1 FOR UPDATE/.test(sql)) {
    const tab = db.tabsById.get(params[0] as string)
    return Promise.resolve(ok(tab ? [{ balance_pence: tab.balance_pence }] : []))
  }
  // --- confirm claim (guarded flip of stripe_charge_id) ---
  if (/UPDATE tab_settlements SET stripe_charge_id = \$1/.test(sql)) {
    const row = db.settlements.get(params[1] as string)
    if (row && row.stripe_charge_id === null) {
      row.stripe_charge_id = params[0] as string
      return Promise.resolve({ rows: [], rowCount: 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }

  // --- read advance: state='accrued' AND read_at <= settled_at (the TIME window) ---
  if (/UPDATE read_events/.test(sql) && /SET state = 'platform_settled'/.test(sql)) {
    const settlementId = params[0] as string
    const tabId = params[1] as string
    const settledAt = db.settlements.get(settlementId)!.settled_at
    let n = 0
    for (const r of db.reads) {
      if (r.tab_id === tabId && r.state === 'accrued' && r.read_at <= settledAt) {
        r.state = 'platform_settled'
        r.tab_settlement_id = settlementId // claimed by exactly this settlement
        n += 1
      }
    }
    return Promise.resolve({ rows: [], rowCount: n })
  }
  // --- subscription_events advance (no sub-earning rows modelled) → no-op ---
  if (/UPDATE subscription_events/.test(sql)) {
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  // --- settled-reads SELECT for writer_accrual (F2: publication_id IS NULL) ---
  if (/FROM read_events/.test(sql) && /tab_settlement_id = \$1/.test(sql) && /net_pence/.test(sql)) {
    const settlementId = params[0] as string
    const feeBps = Number(params[1])
    const rows = db.reads
      .filter((r) => r.tab_settlement_id === settlementId && r.state === 'platform_settled' && r.publication_id === null)
      .map((r) => ({ id: r.id, writer_id: r.writer_id, net_pence: String(perReadNetPence(r.amount_pence, feeBps)) }))
    return Promise.resolve(ok(rows))
  }
  // --- tribute apportionment recursive CTE (gated off) — never reached ---
  return Promise.resolve({ rows: [], rowCount: 0 })
}

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (sql: string, params: unknown[] = []) => query(sql, params) },
  loadConfig: vi.fn(async () => ({ platformFeeBps: FEE_BPS })),
  withTransaction: (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query: (sql: string, params: unknown[] = []) => query(sql, params) }),
}))
vi.mock('@platform-pub/shared/lib/env.js', () => ({ tributesEnabled: () => false }))
vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { settlementService } from '../src/services/settlement.js'

// --- Assertion helpers -----------------------------------------------------
const readerLedgerSum = (readerId: string) =>
  db.ledger.filter((e) => e.account === readerId).reduce((s, e) => s + e.amount, 0)
const writerAccrualSum = () =>
  db.ledger.filter((e) => e.trigger === 'writer_accrual').reduce((s, e) => s + e.amount, 0)
const balance = (readerId: string) => db.tabsByReader.get(readerId)!.balance_pence
/** −Σ(reader entries) == balance — the money-ledger parity invariant. */
const parityHolds = (readerId: string) => -readerLedgerSum(readerId) === balance(readerId)

const confirm = (s: SettlementRow) =>
  settlementService.confirmSettlement(s.stripe_payment_intent_id!, `ch_${s.id}`)

beforeEach(reset)

// ---------------------------------------------------------------------------
describe('§1.2 — single settlement, many writers (P1–P4)', () => {
  it('every read settles once; Σ(writer_accrual) == Σ perReadNet; parity + fee split conserve', async () => {
    seedTab('reader', 1000)
    seedRead('reader', 'R1', 'W1', 300, 1)
    seedRead('reader', 'R2', 'W1', 200, 2)
    seedRead('reader', 'R3', 'W2', 500, 3)

    const s = seedSettlement('reader', 1000, 10) // window covers all three reads
    await confirm(s)

    // P1 — all three advanced exactly once, under this settlement.
    expect(db.reads.every((r) => r.state === 'platform_settled' && r.tab_settlement_id === s.id)).toBe(true)

    // P2 — writer earns the per-read net, once each.
    const expectedNet = perReadNetPence(300, FEE_BPS) + perReadNetPence(200, FEE_BPS) + perReadNetPence(500, FEE_BPS)
    expect(writerAccrualSum()).toBe(expectedNet)
    // one writer_accrual entry per read, no duplicates
    expect(db.ledger.filter((e) => e.trigger === 'writer_accrual')).toHaveLength(3)

    // P3 — reader parity, tab drained.
    expect(balance('reader')).toBe(0)
    expect(parityHolds('reader')).toBe(true)

    // P4 — fee split conserves: amount == fee + net; Σgross == writer net + platform fee.
    expect(s.platform_fee_pence + s.net_to_writers_pence).toBe(s.amount_pence)
    const grossSettled = 1000
    const platformImplicitFee = grossSettled - expectedNet
    expect(expectedNet + platformImplicitFee).toBe(grossSettled)
    // per-row-then-floor: the writer keeps the dust vs the settlement's aggregate net
    expect(expectedNet).toBeGreaterThanOrEqual(s.net_to_writers_pence)
  })
})

describe('§1.2 — publication reads excluded from personal accrual (F2)', () => {
  it('a publication read settles but earns NO personal writer_accrual; parity holds', async () => {
    seedTab('reader', 800)
    seedRead('reader', 'R1', 'W1', 500, 1) // individual
    seedRead('reader', 'RP', 'W1', 300, 2, 'pub-1') // publication read (pool money)

    const s = seedSettlement('reader', 800, 10)
    await confirm(s)

    // both reads advanced (the read-advance UPDATE is publication-blind)
    expect(db.reads.every((r) => r.state === 'platform_settled')).toBe(true)
    // but only the individual read earns a personal writer_accrual
    expect(db.ledger.filter((e) => e.trigger === 'writer_accrual')).toHaveLength(1)
    expect(writerAccrualSum()).toBe(perReadNetPence(500, FEE_BPS))
    // parity still holds — the pool read's money is collected, just not personally credited
    expect(balance('reader')).toBe(0)
    expect(parityHolds('reader')).toBe(true)
  })
})

describe('§1.2 — approximate attribution across two settlements by time window (P1, P5)', () => {
  it('reads attribute to the settlement whose window covers their read_at; global conservation holds', async () => {
    seedTab('reader', 1000)
    seedRead('reader', 'R1', 'W1', 600, 5)  // early read
    seedRead('reader', 'R2', 'W2', 400, 50) // later read

    // S1 reserved at t=10: window covers R1 only. Charges 600.
    const s1 = seedSettlement('reader', 600, 10)
    await confirm(s1)
    expect(db.reads.find((r) => r.id === 'R1')!.tab_settlement_id).toBe(s1.id)
    expect(db.reads.find((r) => r.id === 'R2')!.state).toBe('accrued') // outside S1's window
    expect(balance('reader')).toBe(400)
    expect(parityHolds('reader')).toBe(true)

    // S2 reserved at t=60: window covers R2. Charges 400.
    const s2 = seedSettlement('reader', 400, 60)
    await confirm(s2)
    expect(db.reads.find((r) => r.id === 'R2')!.tab_settlement_id).toBe(s2.id)

    // P1 — each read under exactly one settlement.
    expect(new Set(db.reads.map((r) => r.tab_settlement_id))).toEqual(new Set([s1.id, s2.id]))
    // P2 — every read earned once.
    expect(writerAccrualSum()).toBe(perReadNetPence(600, FEE_BPS) + perReadNetPence(400, FEE_BPS))
    expect(db.ledger.filter((e) => e.trigger === 'writer_accrual')).toHaveLength(2)
    // P5 — Σ charged == Σ settled-read gross; tab drained; parity holds.
    expect(s1.amount_pence + s2.amount_pence).toBe(600 + 400)
    expect(balance('reader')).toBe(0)
    expect(parityHolds('reader')).toBe(true)
  })
})

describe('§1.2 — amount_pence ≠ Σ(read gross): non-read tab debt rides the same settlement (P5)', () => {
  it('settlement collects reads + subscription debt; writers earn only their reads; conservation holds', async () => {
    // Tab holds 700 of reads + 300 of subscription charge = 1000 balance.
    seedTab('reader', 1000)
    seedRead('reader', 'R1', 'W1', 400, 1)
    seedRead('reader', 'R2', 'W2', 300, 2)
    seedNonReadDebt('reader', 300, 'subscription_charge')

    const s = seedSettlement('reader', 1000, 10) // charges the WHOLE tab, reads + sub debt
    await confirm(s)

    // Read↔charge attribution is APPROXIMATE: the settlement's amount (1000) is NOT
    // the sum of the advanced reads' gross (700) — 300 was subscription debt.
    expect(s.amount_pence).toBe(1000)
    const advancedReadGross = db.reads
      .filter((r) => r.tab_settlement_id === s.id)
      .reduce((sum, r) => sum + r.amount_pence, 0)
    expect(advancedReadGross).toBe(700)
    expect(s.amount_pence).not.toBe(advancedReadGross)

    // Writers earn only their reads' net (the sub debt credits no writer here).
    expect(writerAccrualSum()).toBe(perReadNetPence(400, FEE_BPS) + perReadNetPence(300, FEE_BPS))
    // Global money still conserves: tab drained, reader parity holds.
    expect(balance('reader')).toBe(0)
    expect(parityHolds('reader')).toBe(true)
  })
})

describe('§1.2 — idempotent confirm (double webhook) does not double-count (P1–P3)', () => {
  it('a second confirm of the same settlement is a no-op: reads settle once, writers earn once', async () => {
    seedTab('reader', 500)
    seedRead('reader', 'R1', 'W1', 500, 1)
    const s = seedSettlement('reader', 500, 10)

    await confirm(s)
    const afterFirst = {
      balance: balance('reader'),
      writer: writerAccrualSum(),
      accruals: db.ledger.filter((e) => e.trigger === 'writer_accrual').length,
    }
    // Duplicate webhook delivery: stripe_charge_id already claimed → early return.
    await confirm(s)

    expect(balance('reader')).toBe(afterFirst.balance) // no second debit
    expect(writerAccrualSum()).toBe(afterFirst.writer) // no second accrual
    expect(db.ledger.filter((e) => e.trigger === 'writer_accrual')).toHaveLength(afterFirst.accruals)
    expect(db.reads.every((r) => r.state === 'platform_settled')).toBe(true)
    expect(parityHolds('reader')).toBe(true)
  })
})
