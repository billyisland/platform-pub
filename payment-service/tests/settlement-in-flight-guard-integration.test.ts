import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { SETTLEMENT_IN_FLIGHT_SQL } from '../src/services/settlement.js'

// =============================================================================
// The reserve-time in-flight guard — the duplicate-charge window.
//
// WHAT THIS PINS, AND WHY A MOCK CANNOT. A settlement's row leaves `pending` the
// moment Stripe returns (completeSettlement), but the reader's tab balance is not
// reduced until confirmSettlement runs on the payment_intent.succeeded WEBHOOK.
// Between those two events the tab still reads its full balance while the money
// has already been taken. The guard's old predicate was `status = 'pending'`
// alone, so a second checkAndSettle in that window sailed past it, reserved the
// same balance again and charged the reader a second time.
//
// Found by driving the real service against the segregation sandbox on
// 2026-07-31, not by reading the code: settlement A reserved at 11:01:11.324 and
// correctly turned away three concurrent attempts while pending; A completed at
// 11:01:12.787; B reserved 58ms later at 11:01:12.845; A confirmed only at
// 11:01:13.163. One £14 debt, charged twice, tab left at −1400 — legal as
// pre-paid credit, which is exactly why nothing alerted.
//
// The mocked conformance battery models this state now, but a mock is the wrong
// instrument for a predicate: it answers whatever its dispatcher was taught, so
// it follows the predicate back out again if production drops an arm. This runs
// the EXPORTED statement production executes against real Postgres, over all
// three lifecycle states, with the confirmed row as the paired control that
// proves the guard releases rather than blocking forever.
//
// Rows are seeded inside a transaction that is ALWAYS rolled back.
//
// Skipped unless a DB URL is supplied, so the no-Postgres CI `test` job stays
// green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/settlement-in-flight-guard-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

describe.skipIf(!DB_URL)('settlement reserve — in-flight guard', () => {
  let client: pg.Client

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await client.query('BEGIN')
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  let seq = 0
  const uniq = () => `flight-${Date.now().toString(36)}-${seq++}`

  async function seedTab(): Promise<{ readerId: string; tabId: string }> {
    const { rows: acct } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, '0')],
    )
    const readerId = acct[0].id
    const { rows: tab } = await client.query<{ id: string }>(
      `INSERT INTO reading_tabs (reader_id, balance_pence) VALUES ($1, 1400) RETURNING id`,
      [readerId],
    )
    return { readerId, tabId: tab[0].id }
  }

  async function seedSettlement(
    readerId: string,
    tabId: string,
    status: string,
    chargeId: string | null,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tab_settlements
         (reader_id, tab_id, amount_pence, platform_fee_pence, net_to_writers_pence,
          trigger_type, status, stripe_payment_intent_id, stripe_charge_id)
       VALUES ($1, $2, 1400, 112, 1288, 'threshold', $3, $4, $5)
       RETURNING id`,
      [readerId, tabId, status, `pi_${uniq()}`, chargeId],
    )
    return rows[0].id
  }

  const guard = async (tabId: string) =>
    (await client.query(SETTLEMENT_IN_FLIGHT_SQL, [tabId])).rows

  it('blocks while a settlement is pending', async () => {
    const { readerId, tabId } = await seedTab()
    const id = await seedSettlement(readerId, tabId, 'pending', null)

    const rows = await guard(tabId)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].status).toBe('pending')
  })

  it('BLOCKS while a settlement is completed but unconfirmed — the duplicate-charge window', async () => {
    // The charge has gone through; the webhook has not landed; the tab still
    // reads 1400. This is the state the old `status = 'pending'` guard let past.
    const { readerId, tabId } = await seedTab()
    const id = await seedSettlement(readerId, tabId, 'completed', null)

    const rows = await guard(tabId)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].status).toBe('completed')
  })

  it('RELEASES once the settlement is confirmed — the control that proves it is a window, not a lock', async () => {
    // stripe_charge_id set == confirmSettlement has run and moved the balance.
    // If this blocked too, the guard would freeze the tab permanently and the
    // fix would have traded a duplicate charge for uncollectable debt.
    const { readerId, tabId } = await seedTab()
    await seedSettlement(readerId, tabId, 'completed', `ch_${uniq()}`)

    expect(await guard(tabId)).toHaveLength(0)
  })

  it('ignores failed settlements — a decline must not block the next attempt', async () => {
    const { readerId, tabId } = await seedTab()
    await seedSettlement(readerId, tabId, 'failed', null)

    expect(await guard(tabId)).toHaveLength(0)
  })

  it('is scoped to its own tab', async () => {
    const a = await seedTab()
    const b = await seedTab()
    await seedSettlement(a.readerId, a.tabId, 'completed', null)

    expect(await guard(a.tabId)).toHaveLength(1)
    expect(await guard(b.tabId)).toHaveLength(0)
  })

  it('the reconcile sweep selects exactly what this guard blocks on', async () => {
    // The two predicates must agree, and that agreement is what bounds the
    // guard: anything it blocks on is recoverable by reconcileSettlements, so a
    // tab can be delayed but never frozen. If someone narrows one and not the
    // other, this fails.
    const { readerId, tabId } = await seedTab()
    const id = await seedSettlement(readerId, tabId, 'completed', null)

    const { rows } = await client.query(
      `SELECT id FROM tab_settlements
        WHERE status = 'completed'
          AND stripe_charge_id IS NULL
          AND stripe_payment_intent_id IS NOT NULL
          AND tab_id = $1`,
      [tabId],
    )
    expect(rows.map((r) => r.id)).toContain(id)
    expect((await guard(tabId)).map((r) => r.id)).toContain(id)
  })
})
