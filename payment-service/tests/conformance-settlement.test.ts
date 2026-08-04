import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  cardDeclined,
  connectionError,
  idempotencyConflict,
  invalidRequest,
  readerParity,
  type LedgerRow,
} from './support/conformance.js'

// =============================================================================
// SETTLEMENT saga — conformance battery (PAYMENTS ADR §1.1 step 1).
//
// The charge saga: reserve (Txn 1) → paymentIntents.create (stable key
// `settlement-<id>`, OUTSIDE any txn) → complete (Txn 2) → webhook confirm
// (moves the balance via the REAL applyLedgerDelta) → reverse. This file DRIVES
// the real SettlementService against a stateful in-memory model of the three
// tables (tab_settlements / reading_tabs / accounts) + the ledger, so parity and
// the no-clamp invariant hold by CONSTRUCTION, not by asserting a mock's args.
//
// Covered (the drift-pinning checklist from §1.1 step 1):
//   • crash between reserve and the Stripe call → resume completes exactly once
//   • crash after the Stripe charge, before local complete → resume dedups on the
//     stable key, no second charge
//   • terminal charge error → 'failed' + card-action flagged + tab unfrozen, no ledger
//   • ambiguous charge error → NO state change, re-throw, row stays 'pending'
//   • webhook double-delivery + out-of-order (confirm twice; late failure after complete)
//   • resume-sweep idempotency (running the sweep twice is a no-op)
//   • ledger parity −SUM(reader entries) == balance after confirm and after reverse
//   • same-signed-delta / no-clamp: a confirm whose amount exceeds the balance
//     drives the column NEGATIVE (never GREATEST(0,…)) — the money-losing bug class
// =============================================================================

// --- Stripe double: idempotency replay (a create() repeated under the same key
// returns the SAME object, minting nothing new — the crux of exactly-once on
// resume) + programmable outcomes (succeedNext / throwNext). Built in vi.hoisted
// so the mock factory can reference it (a mock factory may only close over
// hoisted values, never a normal import — TDZ). `distinctKeys` = the number of
// real charges (== 1 ⇒ exactly once).
const { paymentIntents, customers } = vi.hoisted(() => {
  function makeResource(prefix: string) {
    const calls: Array<{ key?: string; threw: boolean }> = []
    const byKey = new Map<string, { id: string; [k: string]: unknown }>()
    const byKeyParams = new Map<string, string>()
    const byId = new Map<string, { id: string; [k: string]: unknown }>()
    const script: Array<{ throw?: unknown; obj?: Record<string, unknown> }> = []
    let seq = 0
    let forceListHasMore = false
    return {
      calls,
      get distinctKeys() { return byKey.size },
      createCountFor(key: string) { return calls.filter((c) => c.key === key).length },
      succeedNext(obj?: Record<string, unknown>) { script.push({ obj: obj ?? {} }) },
      throwNext(err: unknown) { script.push({ throw: err }) },
      /** Every list() answers has_more: the recovery's absence proof must refuse
       *  to conclude from a window it cannot finish enumerating. */
      forceListTruncation() { forceListHasMore = true },
      async create(_params: Record<string, unknown>, opts?: { idempotencyKey?: string }) {
        const key = opts?.idempotencyKey
        if (key && byKey.has(key)) {
          // Stripe replays a recorded key only for a byte-identical request;
          // same key + different params is the idempotency conflict (§0o.1).
          if (byKeyParams.get(key) !== JSON.stringify(_params)) {
            calls.push({ key, threw: true })
            throw { type: 'StripeIdempotencyError', rawType: 'idempotency_error' }
          }
          calls.push({ key, threw: false })
          return byKey.get(key)!
        }
        const step = script.shift()
        if (step && 'throw' in step && step.throw !== undefined) { calls.push({ key, threw: true }); throw step.throw }
        seq += 1
        const id = (step?.obj?.id as string) ?? `${prefix}_${seq}`
        // Carries the request's customer/metadata (and a created stamp) so the
        // recovery's list-by-customer + metadata.settlement_id match works
        // against what the create ACTUALLY minted, not a fixture.
        const obj = {
          status: 'succeeded',
          latest_charge: `ch_${seq}`,
          customer: _params.customer,
          metadata: _params.metadata ?? {},
          created: Math.floor(Date.now() / 1000),
          ...(step?.obj ?? {}),
          id,
        }
        calls.push({ key, threw: false })
        if (key) { byKey.set(key, obj); byKeyParams.set(key, JSON.stringify(_params)) }
        byId.set(id, obj)
        return obj
      },
      async retrieve(id: string) { return byId.get(id) ?? { id, status: 'succeeded', latest_charge: `ch_${id}` } },
      async list(params: { customer?: string; created?: { gte?: number }; limit?: number; starting_after?: string }) {
        const data = [...byId.values()].filter(
          (o) =>
            (!params.customer || o.customer === params.customer) &&
            (!params.created?.gte || ((o.created as number) ?? 0) >= params.created.gte),
        )
        return { data, has_more: forceListHasMore }
      },
      _reset() { calls.length = 0; byKey.clear(); byKeyParams.clear(); byId.clear(); script.length = 0; seq = 0; forceListHasMore = false },
    }
  }
  // The reader's saved card, which completeSettlement resolves before charging.
  // A PaymentIntent does NOT inherit invoice_settings.default_payment_method —
  // it must be passed by id — so this double is what the settlement path reads
  // to find the card. `defaultPaymentMethod = null` models a customer with no
  // usable card, which is a terminal skip rather than a charge.
  const customers = {
    defaultPaymentMethod: 'pm_test_default' as string | null,
    deleted: false,
    retrieves: 0,
    async retrieve(id: string) {
      customers.retrieves += 1
      return {
        id,
        deleted: customers.deleted,
        invoice_settings: { default_payment_method: customers.defaultPaymentMethod },
      }
    },
    _reset() {
      customers.defaultPaymentMethod = 'pm_test_default'
      customers.deleted = false
      customers.retrieves = 0
    },
  }
  return { paymentIntents: makeResource('pi'), transfers: makeResource('tr'), customers }
})
vi.mock('stripe', () => ({
  default: class {
    paymentIntents = paymentIntents
    customers = customers
  },
}))
const resetStripe = () => {
  paymentIntents._reset()
  customers._reset()
}

// --- In-memory model of the settlement tables + ledger. One store answers BOTH
// pool.query and the withTransaction client's query (a real DB has one state), so
// a row reserved in Txn 1 is visible to the Stripe-completion UPDATE and the
// later webhook confirm.
interface SettlementRow {
  id: string
  reader_id: string
  tab_id: string
  amount_pence: number
  platform_fee_pence: number
  net_to_writers_pence: number
  trigger_type: string
  status: string
  stripe_payment_intent_id: string | null
  stripe_charge_id: string | null
  reversed_at: string | null
  reversal_reason: string | null
  failure_reason: string | null
  created_at: Date
  seq: number
}
interface TabRow {
  id: string
  reader_id: string
  balance_pence: number
  last_read_at: Date | null
  last_settled_at: Date | null
}
interface AccountRow {
  id: string
  stripe_customer_id: string | null
  card_action_required_at: Date | null
}

const db = {
  settlements: new Map<string, SettlementRow>(),
  tabsById: new Map<string, TabRow>(),
  tabsByReader: new Map<string, TabRow>(),
  accounts: new Map<string, AccountRow>(),
  ledger: [] as LedgerRow[],
  seq: 0,
  /** One-shot crash injectors: the first query matching `re` throws, once. */
  crashers: [] as Array<{ re: RegExp }>,
}

function reset() {
  db.settlements.clear()
  db.tabsById.clear()
  db.tabsByReader.clear()
  db.accounts.clear()
  db.ledger = []
  db.seq = 0
  db.crashers = []
  resetStripe()
}

function seedReader(
  readerId: string,
  balance: number,
  opts: { customer?: string | null; cardFlag?: boolean } = {},
) {
  const tab: TabRow = {
    id: `tab-${readerId}`,
    reader_id: readerId,
    balance_pence: balance,
    last_read_at: new Date(),
    last_settled_at: null,
  }
  db.tabsById.set(tab.id, tab)
  db.tabsByReader.set(readerId, tab)
  db.accounts.set(readerId, {
    id: readerId,
    stripe_customer_id: opts.customer === undefined ? `cus_${readerId}` : opts.customer,
    card_action_required_at: opts.cardFlag ? new Date() : null,
  })
  // A real tab balance is the mirror of read_accrual entries (−amount). Seed the
  // opening entry so −SUM(reader) == balance holds from the start; without it the
  // parity assertions would fail on the seeded debt the ledger never saw.
  if (balance !== 0) {
    db.ledger.push({ account: readerId, counterparty: null, amount: -balance, trigger: 'read_accrual' })
  }
}

/** Move a reader's tab balance AND post the mirror ledger entry (the invariant a
 *  real money path upholds). Used to model a credit landing between reserve and
 *  confirm — keeps parity consistent so the confirm's no-clamp behaviour is what
 *  the assertion actually isolates. */
function mirrorMove(readerId: string, deltaBalance: number, trigger: string) {
  const tab = db.tabsByReader.get(readerId)!
  tab.balance_pence += deltaBalance
  db.ledger.push({ account: readerId, counterparty: null, amount: -deltaBalance, trigger })
}

/** Simulate a process crash: the next query matching `re` throws. */
function crashOn(re: RegExp) {
  db.crashers.push({ re })
}

const ok = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length })

function query(sql: string, params: unknown[] = []) {
  for (let i = 0; i < db.crashers.length; i++) {
    if (db.crashers[i].re.test(sql)) {
      db.crashers.splice(i, 1)
      return Promise.reject(new Error('simulated crash'))
    }
  }

  // --- applyLedgerDelta: reading_tabs upsert (by reader_id) + ledger insert ---
  if (/INSERT INTO reading_tabs/.test(sql)) {
    const readerId = params[0] as string
    const delta = Number(params[1])
    let tab = db.tabsByReader.get(readerId)
    if (!tab) {
      tab = { id: `tab-${readerId}`, reader_id: readerId, balance_pence: 0, last_read_at: null, last_settled_at: null }
      db.tabsById.set(tab.id, tab)
      db.tabsByReader.set(readerId, tab)
    }
    tab.balance_pence += delta // NO clamp — mirrors the primitive exactly
    return Promise.resolve(ok([{ id: tab.id, balance_pence: tab.balance_pence }]))
  }
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

  // --- reserve INSERT ---
  if (/INSERT INTO tab_settlements/.test(sql)) {
    db.seq += 1
    const id = `settle-${db.seq}`
    const row: SettlementRow = {
      id,
      reader_id: params[0] as string,
      tab_id: params[1] as string,
      amount_pence: Number(params[2]),
      platform_fee_pence: Number(params[3]),
      net_to_writers_pence: Number(params[4]),
      trigger_type: params[5] as string,
      status: 'pending',
      stripe_payment_intent_id: null,
      stripe_charge_id: null,
      reversed_at: null,
      reversal_reason: null,
      failure_reason: null,
      created_at: new Date(),
      seq: db.seq,
    }
    db.settlements.set(id, row)
    return Promise.resolve(ok([{ id }]))
  }

  // --- checkAndSettle: joined tab+account by reader_id ---
  if (/FROM reading_tabs t/.test(sql) && /JOIN accounts a/.test(sql) && /WHERE t\.reader_id = \$1/.test(sql)) {
    const tab = db.tabsByReader.get(params[0] as string)
    if (!tab) return Promise.resolve(ok([]))
    const acc = db.accounts.get(tab.reader_id)!
    return Promise.resolve(
      ok([{
        id: tab.id,
        balance_pence: tab.balance_pence,
        last_read_at: tab.last_read_at,
        last_settled_at: tab.last_settled_at,
        stripe_customer_id: acc.stripe_customer_id,
        card_action_required_at: acc.card_action_required_at,
      }]),
    )
  }
  // --- resume: customer lookup by tab id ---
  if (/stripe_customer_id/.test(sql) && /WHERE t\.id = \$1/.test(sql)) {
    const tab = db.tabsById.get(params[0] as string)
    const acc = tab ? db.accounts.get(tab.reader_id) : undefined
    return Promise.resolve(ok(acc ? [{ stripe_customer_id: acc.stripe_customer_id }] : []))
  }
  // --- tab lock (reserve / confirm / reverse) ---
  if (/FROM reading_tabs WHERE id = \$1 FOR UPDATE/.test(sql)) {
    const tab = db.tabsById.get(params[0] as string)
    return Promise.resolve(ok(tab ? [{ balance_pence: tab.balance_pence }] : []))
  }

  // --- reserve in-flight guard ---
  // "In flight" is `pending` OR `completed`-but-unconfirmed. The second arm is
  // the one that matters: a settlement whose charge has gone through but whose
  // webhook has not yet moved the tab balance. Modelled here as a real table
  // would answer it; the BEHAVIOURAL pin for the predicate itself is the
  // DB-backed settlement-in-flight-guard-integration.test.ts, which runs the
  // exported SQL against real Postgres — a mock that derived its answer from
  // the SQL it was handed would silently follow the predicate back out again.
  if (/FROM tab_settlements\s+WHERE tab_id = \$1/.test(sql) && /status = 'pending'/.test(sql)) {
    const inFlight = [...db.settlements.values()].find(
      (s) =>
        s.tab_id === params[0] &&
        (s.status === 'pending' ||
          (s.status === 'completed' && s.stripe_charge_id === null)),
    )
    return Promise.resolve(
      ok(inFlight ? [{ id: inFlight.id, status: inFlight.status }] : []),
    )
  }
  // --- resume pending list ---
  if (/SELECT id, reader_id, tab_id, amount_pence, trigger_type, created_at\s+FROM tab_settlements\s+WHERE status = 'pending'/.test(sql)) {
    const rows = [...db.settlements.values()]
      .filter((s) => s.status === 'pending')
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({ id: s.id, reader_id: s.reader_id, tab_id: s.tab_id, amount_pence: s.amount_pence, trigger_type: s.trigger_type, created_at: s.created_at }))
    return Promise.resolve(ok(rows))
  }
  // --- idempotency-conflict recovery: row created_at (window floor) ---
  if (/SELECT created_at FROM tab_settlements WHERE id = \$1 AND status = 'pending'/.test(sql)) {
    const row = db.settlements.get(params[0] as string)
    return Promise.resolve(
      ok(row && row.status === 'pending' ? [{ created_at: row.created_at }] : []),
    )
  }
  // --- confirm §0o.7c fallback: lookup by metadata settlement id, un-owned rows only ---
  if (/FROM tab_settlements\s+WHERE id = \$1 AND stripe_payment_intent_id IS NULL/.test(sql)) {
    const row = db.settlements.get(params[0] as string)
    return Promise.resolve(
      ok(row && row.stripe_payment_intent_id === null
        ? [{ id: row.id, reader_id: row.reader_id, tab_id: row.tab_id, amount_pence: row.amount_pence, stripe_charge_id: row.stripe_charge_id, status: row.status }]
        : []),
    )
  }
  // --- confirm lookup by PI id ---
  if (/FROM tab_settlements\s+WHERE stripe_payment_intent_id = \$1/.test(sql)) {
    const row = [...db.settlements.values()].find((s) => s.stripe_payment_intent_id === params[0])
    return Promise.resolve(
      ok(row ? [{ id: row.id, reader_id: row.reader_id, tab_id: row.tab_id, amount_pence: row.amount_pence, stripe_charge_id: row.stripe_charge_id, status: row.status }] : []),
    )
  }
  // --- reverse lookup by charge id ---
  if (/FROM tab_settlements\s+WHERE stripe_charge_id = \$1/.test(sql)) {
    const row = [...db.settlements.values()].find((s) => s.stripe_charge_id === params[0])
    return Promise.resolve(
      ok(row ? [{ id: row.id, reader_id: row.reader_id, tab_id: row.tab_id, amount_pence: row.amount_pence, reversed_at: row.reversed_at }] : []),
    )
  }

  // --- UPDATE tab_settlements variants ---
  if (/UPDATE tab_settlements/.test(sql)) {
    // completeSettlement success flip
    if (/status = 'completed'/.test(sql)) {
      const row = db.settlements.get(params[1] as string)
      if (row && row.status === 'pending') {
        row.status = 'completed'
        row.stripe_payment_intent_id = params[0] as string
        return Promise.resolve({ rows: [], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    // terminal decline flip (failure_reason present)
    if (/failure_reason = \$2/.test(sql)) {
      const row = db.settlements.get(params[2] as string)
      if (row && row.status === 'pending') {
        row.status = 'failed'
        row.stripe_payment_intent_id = (params[0] as string | null) ?? row.stripe_payment_intent_id
        row.failure_reason = params[1] as string
        return Promise.resolve({ rows: [], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    // confirm §0o.7c adopt (rowCount-guarded on IS NULL, like the real table)
    if (/SET stripe_payment_intent_id = \$1\s+WHERE id = \$2 AND stripe_payment_intent_id IS NULL/.test(sql)) {
      const row = db.settlements.get(params[1] as string)
      if (row && row.stripe_payment_intent_id === null) {
        row.stripe_payment_intent_id = params[0] as string
        return Promise.resolve({ rows: [], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    // no-card / no-customer failure (failure_reason = $1, id = $2 — the
    // completeSettlement no-default-card and resume no-customer branches)
    if (/failure_reason = \$1/.test(sql) && /AND status = 'pending'/.test(sql)) {
      const row = db.settlements.get(params[1] as string)
      if (row && row.status === 'pending') {
        row.status = 'failed'
        row.failure_reason = params[0] as string
        return Promise.resolve({ rows: [], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    // confirm claim
    if (/SET stripe_charge_id = \$1/.test(sql)) {
      const row = db.settlements.get(params[1] as string)
      if (row && row.stripe_charge_id === null) {
        row.stripe_charge_id = params[0] as string
        return Promise.resolve({ rows: [], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    // reverse claim
    if (/SET reversed_at = now\(\)/.test(sql)) {
      const row = db.settlements.get(params[0] as string)
      if (row && row.reversed_at === null) {
        row.reversed_at = 'now'
        row.reversal_reason = params[1] as string
        return Promise.resolve({ rows: [], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    // handleFailedPayment guarded flip (pending → failed, no failure_reason col)
    if (/SET status = 'failed'/.test(sql) && /AND status = 'pending'/.test(sql)) {
      const row = db.settlements.get(params[0] as string)
      if (row && row.status === 'pending') {
        row.status = 'failed'
        return Promise.resolve({ rows: [], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    // (The old unguarded resume no-customer flip is gone — §0o.7b moved that
    // branch onto the failure_reason = $1 shape above. No arm for an unguarded
    // `SET status = 'failed'` on purpose: reintroducing one in production
    // should surface here as a routing gap, not be silently absorbed.)
  }

  // --- accounts card-action flag ---
  if (/UPDATE accounts\s+SET card_action_required_at = now\(\)/.test(sql)) {
    const acc = db.accounts.get(params[0] as string)
    if (acc) acc.card_action_required_at = new Date()
    return Promise.resolve({ rows: [], rowCount: acc ? 1 : 0 })
  }

  // --- settled-reads SELECT (writer accrual) → empty by default ---
  if (/FROM read_events\s+WHERE tab_settlement_id = \$1\s+AND state = 'platform_settled'/.test(sql)) {
    return Promise.resolve(ok([]))
  }
  // --- reverse affected reads → empty ---
  if (/FROM read_events\s+WHERE tab_settlement_id = \$1\s+AND state IN \('platform_settled', 'writer_paid'\)/.test(sql)) {
    return Promise.resolve(ok([]))
  }
  // --- reverse accruals → empty ---
  if (/FROM tribute_accruals a/.test(sql)) {
    return Promise.resolve(ok([]))
  }

  // Everything else (read/sub advances, charged_back / voided UPDATEs) → no-op.
  return Promise.resolve({ rows: [], rowCount: 1 })
}

// NB: mock factories are hoisted above imports, so they must reference only the
// hoisted `query` function declaration — never the imported TEST_CONFIG or a
// later `const` (TDZ). The config is inlined here to match TEST_CONFIG.
vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (sql: string, params: unknown[] = []) => query(sql, params) },
  loadConfig: vi.fn(async () => ({
    platformFeeBps: 800,
    tabSettlementThresholdPence: 800,
    monthlyFallbackMinimumPence: 200,
    monthlyFallbackDays: 30,
    writerPayoutThresholdPence: 2000,
    freeAllowancePence: 500,
  })),
  withTransaction: (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query: (sql: string, params: unknown[] = []) => query(sql, params) }),
}))

vi.mock('@platform-pub/shared/lib/env.js', () => ({
  tributesEnabled: () => false,
  allocatedFundsEnabled: () => false,
}))

vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { settlementService } from '../src/services/settlement.js'
import logger from '../src/lib/logger.js'

const only = () => [...db.settlements.values()][0]

beforeEach(() => {
  reset()
})

// ---------------------------------------------------------------------------
describe('settlement — crash & resume (exactly once)', () => {
  it('crash between reserve and the Stripe call → resume completes exactly once', async () => {
    seedReader('reader-1', 1000)
    // The charge request fails ambiguously (connection lost mid-flight) — models a
    // crash before any charge landed. The row is reserved but stays 'pending'.
    paymentIntents.throwNext(connectionError())
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()

    expect(only().status).toBe('pending')
    expect(paymentIntents.distinctKeys).toBe(0) // no charge yet
    expect(db.ledger.filter((e) => e.trigger.startsWith('tab_settlement'))).toHaveLength(0) // no settlement money moved (that's confirm's job)

    // Resume: the transient blip is gone; the charge succeeds under the SAME key.
    paymentIntents.succeedNext()
    await settlementService.resumePendingSettlements()

    expect(only().status).toBe('completed')
    expect(paymentIntents.distinctKeys).toBe(1) // exactly one charge
    expect(paymentIntents.createCountFor(`settlement-${only().id}`)).toBe(2) // attempted twice
  })

  it('crash after the Stripe charge, before local complete → resume dedups, no second charge', async () => {
    seedReader('reader-1', 1000)
    // The charge SUCCEEDS, then the completion UPDATE "crashes" before it lands.
    crashOn(/UPDATE tab_settlements\s+SET stripe_payment_intent_id = \$1, status = 'completed'/)
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()

    expect(only().status).toBe('pending') // completion never landed
    expect(paymentIntents.distinctKeys).toBe(1) // but the charge DID go through

    // Resume: create() under the same key REPLAYS the existing charge (no new one).
    await settlementService.resumePendingSettlements()

    expect(only().status).toBe('completed')
    expect(paymentIntents.distinctKeys).toBe(1) // still exactly one charge
    expect(only().stripe_payment_intent_id).toBe('pi_1')
  })

  it('resume with NO customer record fails the row AND flags for card attach (§0o.7b)', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.throwNext(connectionError())
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()
    expect(only().status).toBe('pending')

    // The customer record vanished between reserve and resume (detached, or
    // the account row rewritten). Previously this branch failed the row
    // SILENTLY — tab unfrozen, but the reader never prompted to attach a card,
    // so settlement just stopped with nothing telling them why.
    db.accounts.get('reader-1')!.stripe_customer_id = null

    await settlementService.resumePendingSettlements()

    expect(only().status).toBe('failed')
    expect(only().failure_reason).toBe('no_stripe_customer')
    expect(db.accounts.get('reader-1')!.card_action_required_at).not.toBeNull()
  })

  it('a PI created but never stored confirms via metadata.settlement_id (§0o.7c)', async () => {
    seedReader('reader-1', 1000)
    crashOn(/UPDATE tab_settlements\s+SET stripe_payment_intent_id = \$1, status = 'completed'/)
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()
    expect(only().stripe_payment_intent_id).toBeNull() // the id was never stored
    expect(paymentIntents.distinctKeys).toBe(1) // but the charge DID go through

    // The success webhook arrives before any resume, carrying the metadata the
    // create stamped. Without the hint this event warn-ignores and the row
    // waits on the resume sweep's same-key dedupe — the channel §0o.1 showed
    // can wedge on payload drift.
    await settlementService.confirmSettlement('pi_1', 'ch_1', only().id)

    expect(only().stripe_payment_intent_id).toBe('pi_1') // adopted
    expect(only().stripe_charge_id).toBe('ch_1') // and confirmed
    const tab = db.tabsByReader.get('reader-1')!
    expect(tab.balance_pence).toBe(0)
    expect(readerParity(db.ledger, 'reader-1', tab.balance_pence)).toBe(true)
    // Status stays 'pending' until the resume sweep's same-key dedupe flips it
    // — the identical eventual flip the id-stored crash window has always
    // used; the duplicate-claim guard makes that later confirm a no-op.
  })

  it('the metadata fallback never steals a row that belongs to a DIFFERENT intent', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.succeedNext() // pi_1, stored normally
    await settlementService.checkAndSettle('reader-1')
    expect(only().stripe_payment_intent_id).toBe('pi_1')

    // A stray success for some other PI carrying our settlement id as its hint
    // (a manual dashboard charge copying metadata, a forged event) must not
    // clobber the row: the IS NULL guard refuses the adopt and the event is
    // warn-ignored.
    await settlementService.confirmSettlement('pi_other', 'ch_other', only().id)

    expect(only().stripe_payment_intent_id).toBe('pi_1')
    expect(only().stripe_charge_id).toBeNull() // untouched — nothing confirmed
  })
})

// ---------------------------------------------------------------------------
describe('settlement — terminal vs ambiguous', () => {
  it('terminal decline → failed, card-action flagged, tab unfrozen, no ledger', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.throwNext(cardDeclined())
    // Terminal path swallows the error (returns), does not re-throw.
    await expect(settlementService.checkAndSettle('reader-1')).resolves.not.toThrow()

    expect(only().status).toBe('failed')
    expect(only().failure_reason).toBe('card_declined')
    expect(db.accounts.get('reader-1')!.card_action_required_at).not.toBeNull()
    expect(db.ledger.filter((e) => e.trigger.startsWith('tab_settlement'))).toHaveLength(0) // nothing charged → nothing to reverse
    // The pending-guard now releases: a fresh attempt can reserve again.
    const pending = [...db.settlements.values()].filter((s) => s.status === 'pending')
    expect(pending).toHaveLength(0)
  })

  it('ambiguous transient error → NO state change, re-throw, row stays pending', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.throwNext(connectionError())
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()

    expect(only().status).toBe('pending') // NOT marked failed — the charge may yet land
    expect(only().failure_reason).toBeNull()
    expect(db.accounts.get('reader-1')!.card_action_required_at).toBeNull() // not backed off
    expect(db.ledger.filter((e) => e.trigger.startsWith('tab_settlement'))).toHaveLength(0)
  })

  it('a StripeInvalidRequestError is terminal for a charge too', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.throwNext(invalidRequest())
    await expect(settlementService.checkAndSettle('reader-1')).resolves.not.toThrow()
    expect(only().status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
describe('settlement — ledger parity & no-clamp (the money-losing bug class)', () => {
  it('confirm moves the balance down by the full amount and posts the mirror (parity holds)', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.succeedNext() // pi_1
    await settlementService.checkAndSettle('reader-1')
    expect(only().status).toBe('completed')

    await settlementService.confirmSettlement('pi_1', 'ch_1')

    const tab = db.tabsByReader.get('reader-1')!
    expect(tab.balance_pence).toBe(0) // 1000 debt paid down by the 1000 settle
    const entry = db.ledger.find((e) => e.trigger === 'tab_settlement')!
    expect(entry.amount).toBe(1000) // +amount reader credit (debt paid)
    expect(readerParity(db.ledger, 'reader-1', tab.balance_pence)).toBe(true)
  })

  it('a confirm whose amount exceeds the (since-dropped) balance drives the column NEGATIVE, not GREATEST(0,…)', async () => {
    // Reserve 1000 at threshold, charge succeeds. Then the balance drops to 300
    // (a refund/credit landed between reserve and confirm). The confirm still
    // settles the full 1000 — the column must go to −700, and the ledger mirror
    // stays in lockstep. Clamping the column at 0 while the ledger posts +1000 is
    // exactly the divergence that lost money (2026-06-20 HIGH #1).
    seedReader('reader-1', 1000)
    paymentIntents.succeedNext()
    await settlementService.checkAndSettle('reader-1')

    mirrorMove('reader-1', -700, 'subscription_credit') // a credit landed: debt 1000 → 300

    await settlementService.confirmSettlement('pi_1', 'ch_1')

    const tab = db.tabsByReader.get('reader-1')!
    expect(tab.balance_pence).toBe(-700) // NOT floored at 0
    expect(readerParity(db.ledger, 'reader-1', tab.balance_pence)).toBe(true)
  })

  it('reversal restores the debt and conserves parity across confirm → reverse', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.succeedNext()
    await settlementService.checkAndSettle('reader-1')
    await settlementService.confirmSettlement('pi_1', 'ch_1')
    expect(db.tabsByReader.get('reader-1')!.balance_pence).toBe(0)

    await settlementService.reverseSettlement('ch_1', 'chargeback_lost')

    const tab = db.tabsByReader.get('reader-1')!
    expect(tab.balance_pence).toBe(1000) // debt restored (no reads to claw back here)
    expect(db.ledger.find((e) => e.trigger === 'tab_settlement_reversal')!.amount).toBe(-1000)
    expect(readerParity(db.ledger, 'reader-1', tab.balance_pence)).toBe(true)
    expect(db.accounts.get('reader-1')!.card_action_required_at).not.toBeNull() // F12 back-off
  })
})

// ---------------------------------------------------------------------------
describe('settlement — webhook double-delivery & out-of-order', () => {
  it('a re-delivered confirm moves the balance exactly once', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.succeedNext()
    await settlementService.checkAndSettle('reader-1')

    await settlementService.confirmSettlement('pi_1', 'ch_1')
    await settlementService.confirmSettlement('pi_1', 'ch_1') // duplicate delivery

    const tab = db.tabsByReader.get('reader-1')!
    expect(tab.balance_pence).toBe(0) // moved once, not twice
    expect(db.ledger.filter((e) => e.trigger === 'tab_settlement')).toHaveLength(1)
    expect(readerParity(db.ledger, 'reader-1', tab.balance_pence)).toBe(true)
  })

  it('a late payment_failed after the row already completed is a no-op', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.succeedNext()
    await settlementService.checkAndSettle('reader-1')
    await settlementService.confirmSettlement('pi_1', 'ch_1')
    expect(only().status).toBe('completed')

    // Out-of-order: the failure webhook arrives after success — the guarded
    // WHERE status = 'pending' claims 0 rows, so nothing is corrupted.
    await settlementService.handleFailedPayment('pi_1', 'late failure')

    expect(only().status).toBe('completed')
    expect(db.tabsByReader.get('reader-1')!.balance_pence).toBe(0)
  })

  it('a re-delivered reversal claws back exactly once', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.succeedNext()
    await settlementService.checkAndSettle('reader-1')
    await settlementService.confirmSettlement('pi_1', 'ch_1')

    await settlementService.reverseSettlement('ch_1', 'refund')
    await settlementService.reverseSettlement('ch_1', 'refund') // duplicate

    const tab = db.tabsByReader.get('reader-1')!
    expect(tab.balance_pence).toBe(1000) // restored once
    expect(db.ledger.filter((e) => e.trigger === 'tab_settlement_reversal')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
describe('settlement — resume-sweep idempotency', () => {
  it('running the resume sweep twice on a completed row is a no-op', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.succeedNext()
    await settlementService.checkAndSettle('reader-1')
    expect(only().status).toBe('completed')

    const chargesBefore = paymentIntents.distinctKeys
    await settlementService.resumePendingSettlements()
    await settlementService.resumePendingSettlements()

    expect(paymentIntents.distinctKeys).toBe(chargesBefore) // no extra charges
    expect(only().status).toBe('completed')
  })

  it('the sweep on an empty pending set does nothing', async () => {
    await settlementService.resumePendingSettlements()
    expect(paymentIntents.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// §0o.1 — the idempotency-conflict wedge. completeSettlement rebuilds its
// payload per attempt, so a card swap / deploy / brand flip between an
// ambiguous first attempt and its resume turns the row-stable key into a
// permanent StripeIdempotencyError: before the recovery, the row stayed
// 'pending' forever and the in-flight guard froze the TAB with it (three dev
// settlements measured wedged, 2026-07-31).
describe('settlement — idempotency-conflict recovery (§0o.1)', () => {
  it('card swap after a charged-but-uncompleted attempt → the retry conflicts, recovery ADOPTS the first charge (no second charge)', async () => {
    seedReader('reader-1', 1000)
    // Attempt 1: the charge goes through, the local completion UPDATE crashes.
    crashOn(/UPDATE tab_settlements\s+SET stripe_payment_intent_id = \$1, status = 'completed'/)
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()
    expect(only().status).toBe('pending')
    expect(paymentIntents.distinctKeys).toBe(1) // the charge exists at Stripe

    // The reader swaps their default card before the resume: the rebuilt
    // payload no longer matches the recorded key.
    customers.defaultPaymentMethod = 'pm_swapped'
    await settlementService.resumePendingSettlements()

    // Recovery found pi_1 via metadata.settlement_id and adopted it — and the
    // charge id was already known, so it confirmed immediately.
    expect(only().status).toBe('completed')
    expect(only().stripe_payment_intent_id).toBe('pi_1')
    expect(paymentIntents.distinctKeys).toBe(1) // STILL exactly one charge
    const tab = db.tabsByReader.get('reader-1')!
    expect(tab.balance_pence).toBe(0) // confirm ran: debt paid down
    expect(db.ledger.filter((e) => e.trigger === 'tab_settlement')).toHaveLength(1)
    expect(readerParity(db.ledger, 'reader-1', tab.balance_pence)).toBe(true)
  })

  it('conflict with the first attempt\'s PI in a dead state → terminal-decline disposition (failed + card flag + PI id kept)', async () => {
    seedReader('reader-1', 1000)
    // Attempt 1 minted a PI that is going nowhere without the reader (SCA/decline
    // recorded on it), and the process died before the local completion landed.
    paymentIntents.succeedNext({ status: 'requires_payment_method', latest_charge: null })
    crashOn(/UPDATE tab_settlements\s+SET stripe_payment_intent_id = \$1, status = 'completed'/)
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()
    expect(only().status).toBe('pending')

    customers.defaultPaymentMethod = 'pm_swapped' // drift → conflict on resume
    await settlementService.resumePendingSettlements()

    expect(only().status).toBe('failed')
    expect(only().failure_reason).toBe('requires_payment_method')
    expect(only().stripe_payment_intent_id).toBe('pi_1') // kept for the failure webhook
    expect(db.accounts.get('reader-1')!.card_action_required_at).not.toBeNull()
    expect(paymentIntents.distinctKeys).toBe(1) // no fresh charge minted
    expect(db.ledger.filter((e) => e.trigger.startsWith('tab_settlement'))).toHaveLength(0)
  })

  it('conflict but provably NO PaymentIntent exists → failed WITHOUT the card flag, and a fresh reserve settles cleanly under a fresh key', async () => {
    seedReader('reader-1', 1000)
    // Attempt 1 never created anything (ambiguous network failure)…
    paymentIntents.throwNext(connectionError())
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()
    // …but Stripe recorded the key (e.g. the first request 500'd server-side),
    // so the resume's rebuilt payload now conflicts.
    paymentIntents.throwNext(idempotencyConflict())
    await settlementService.resumePendingSettlements()

    // Enumerated the whole window, found nothing → the row fails so the tab
    // unfreezes — and the card is NOT flagged, because it was never the problem.
    expect(only().status).toBe('failed')
    expect(only().failure_reason).toBe('idempotency_key_conflict')
    expect(db.accounts.get('reader-1')!.card_action_required_at).toBeNull()

    // Convergence: the next settle reserves a FRESH row, whose fresh key
    // charges cleanly with the current payload.
    await settlementService.checkAndSettle('reader-1')
    const rows = [...db.settlements.values()]
    expect(rows).toHaveLength(2)
    expect(rows[1].status).toBe('completed')
    expect(paymentIntents.distinctKeys).toBe(1) // exactly one real charge, the new one
  })

  it('conflict with a truncated enumeration window → absence unproven, row left pending, nothing charged or failed', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.throwNext(connectionError())
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()

    paymentIntents.forceListTruncation() // recovery can never see the whole window
    paymentIntents.throwNext(idempotencyConflict())
    await settlementService.resumePendingSettlements()

    expect(only().status).toBe('pending') // no guess: failing here could double-charge
    expect(only().failure_reason).toBeNull()
    expect(db.accounts.get('reader-1')!.card_action_required_at).toBeNull()
    expect(paymentIntents.distinctKeys).toBe(0)
  })

  it('a pending row older than a full retry cycle trips the STUCK PENDING alert; a fresh one does not', async () => {
    seedReader('reader-1', 1000)
    paymentIntents.throwNext(connectionError())
    await expect(settlementService.checkAndSettle('reader-1')).rejects.toThrow()

    vi.mocked(logger.error).mockClear()
    paymentIntents.throwNext(connectionError()) // still failing, but row is fresh
    await settlementService.resumePendingSettlements()
    expect(
      vi.mocked(logger.error).mock.calls.some(([, msg]) => typeof msg === 'string' && msg.includes('SETTLEMENT STUCK PENDING')),
    ).toBe(false)

    only().created_at = new Date(Date.now() - 9 * 3600_000) // past one 8h cycle
    paymentIntents.throwNext(connectionError())
    await settlementService.resumePendingSettlements()
    expect(
      vi.mocked(logger.error).mock.calls.some(([, msg]) => typeof msg === 'string' && msg.includes('SETTLEMENT STUCK PENDING')),
    ).toBe(true)
  })
})
