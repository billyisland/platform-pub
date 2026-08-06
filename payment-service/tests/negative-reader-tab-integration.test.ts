import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { NEGATIVE_READER_TAB_SQL } from '../src/services/reconcile-ledger.js'

// =============================================================================
// PAYMENT-PERIMETER-ADR W1 — "a negative reading tab becomes an incident, not a
// legal state". This is the DB half of the acceptance criterion:
//
//   a synthetic double-settlement produces (a) a negative tab and (b) an alert
//   naming the account and settlement, with no other account's payouts frozen.
//
// (b)'s severity-tier half — alert-never-halt, and the marker it alerts under —
// is proved against a scripted client in `ledger-reconcile.test.ts`. THIS file
// proves the half only Postgres can: that the detector's SQL actually finds the
// tab, resolves the LATERAL join to the settlement that produced it, and — the
// point of the whole check — that the state it detects is one the EXISTING
// parity check passes over in silence.
//
// Why DB-backed. The `reader_balance_parity` check compares two quantities; a
// negative tab that AGREES with its ledger satisfies it. That agreement is the
// gap W1 exists to close, and a mocked `pool.query` cannot demonstrate a gap
// between two SQL predicates — it would answer both from fixtures I chose.
// Only Postgres evaluates `ledger_reader_balance` (a SUM() view over
// ledger_entries) against `reading_tabs.balance_pence` for real.
//
// THE CONTROL IS THE POINT. Every assertion is paired: the parity check is run
// over the SAME synthetic rows and asserted CLEAN. Without that pair, "the new
// check fires" proves nothing about whether the old one already did.
//
// Runs the REAL exported statement the service executes, inside a transaction
// that is ALWAYS rolled back, so the target DB is never mutated.
//
// Skipped unless a DB URL is supplied, so the no-Postgres CI `test` job stays
// green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/negative-reader-tab-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

// The B1 parity predicate, copied from reconcile-ledger.ts's
// `reader_balance_parity` check, scoped to our synthetic reader. It is a COPY on
// purpose: the point of the control is "the shipped parity predicate is blind to
// this", so it must be the predicate as shipped, restricted — not a rewrite.
const PARITY_SQL = `
  SELECT COALESCE(rt.reader_id, rb.account_id)  AS account_id,
         COALESCE(rt.balance_pence, 0)          AS tab_balance_pence,
         COALESCE(rb.balance_pence, 0)          AS ledger_balance_pence
  FROM reading_tabs rt
  FULL OUTER JOIN ledger_reader_balance rb ON rb.account_id = rt.reader_id
  WHERE COALESCE(rt.balance_pence, 0) <> COALESCE(rb.balance_pence, 0)
    AND COALESCE(rt.reader_id, rb.account_id) = $1`

describe.skipIf(!DB_URL)('a reading tab in credit is detected as an incident (W1)', () => {
  let client: pg.Client
  let readerId: string
  let otherReaderId: string
  let tabId: string

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await client.query('BEGIN')

    const mk = async (suffix: string) => {
      const { rows } = await client.query(
        `INSERT INTO accounts (nostr_pubkey, username, display_name)
         VALUES ($1, $2, $3) RETURNING id`,
        [`w1test${suffix}${Date.now()}`, `w1test${suffix}${Date.now()}`, 'W1 test'],
      )
      return rows[0].id as string
    }
    readerId = await mk('a')
    otherReaderId = await mk('b')

    const { rows: tabs } = await client.query(
      `INSERT INTO reading_tabs (reader_id, balance_pence) VALUES ($1, 0) RETURNING id`,
      [readerId],
    )
    tabId = tabs[0].id
  })

  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  /**
   * The August 2026 shape, reproduced: one tab owing £8, settled TWICE. Each
   * settlement pays the tab down and posts its mirror ledger credit through the
   * same signed pair `applyLedgerDelta` guarantees — so the books stay exactly
   * to the penny while the reader ends up £8 in credit.
   */
  async function doubleSettle(owedPence: number) {
    // The reader owes: an accrual moves the tab UP and posts the mirror −amount.
    await client.query(
      `UPDATE reading_tabs SET balance_pence = balance_pence + $1 WHERE id = $2`,
      [owedPence, tabId],
    )
    await client.query(
      `INSERT INTO ledger_entries (account_id, counterparty_id, amount_pence, trigger_type, ref_table, ref_id)
       VALUES ($1, NULL, $2, 'opening_balance', 'reading_tabs', $3)`,
      [readerId, -owedPence, tabId],
    )

    const settlementIds: string[] = []
    for (let i = 0; i < 2; i++) {
      const { rows } = await client.query(
        `INSERT INTO tab_settlements
           (reader_id, tab_id, amount_pence, platform_fee_pence, net_to_writers_pence,
            trigger_type, status, stripe_payment_intent_id, settled_at)
         VALUES ($1, $2, $3, 0, $3, 'threshold', 'completed', $4, now() + ($5 || ' seconds')::interval)
         RETURNING id`,
        [readerId, tabId, owedPence, `pi_w1_${i}`, String(i)],
      )
      settlementIds.push(rows[0].id)

      // The confirm leg, as applyLedgerDelta performs it: column −amount, mirror
      // ledger +amount. Unclamped — that is the invariant, and it is what lets
      // the second settlement take the tab below zero.
      await client.query(
        `UPDATE reading_tabs SET balance_pence = balance_pence - $1 WHERE id = $2`,
        [owedPence, tabId],
      )
      await client.query(
        `INSERT INTO ledger_entries (account_id, counterparty_id, amount_pence, trigger_type, ref_table, ref_id)
         VALUES ($1, NULL, $2, 'tab_settlement', 'tab_settlements', $3)`,
        [readerId, owedPence, rows[0].id],
      )
    }
    return settlementIds
  }

  it('a double-settled tab goes into credit, agrees with its ledger, and the parity check is blind to it', async () => {
    await doubleSettle(800)

    const { rows: tab } = await client.query(
      `SELECT balance_pence FROM reading_tabs WHERE id = $1`,
      [tabId],
    )
    expect(tab[0].balance_pence).toBe(-800) // (a) the reader is £8 in credit

    // THE CONTROL. The books agree to the penny, so the shipped parity check —
    // the only reader-tab check there was before W1 — passes. This is the
    // silence the August incident happened in.
    const { rows: parity } = await client.query(PARITY_SQL, [readerId])
    expect(parity).toHaveLength(0)
  })

  it('the W1 detector finds it, and names the account, the credit and the settlement', async () => {
    const settlementIds = await doubleSettle(800)

    const { rows } = await client.query(NEGATIVE_READER_TAB_SQL)
    const found = rows.find((r) => r.account_id === readerId)

    expect(found).toBeDefined() // (b) detected
    expect(found!.credit_pence).toBe(-800)
    // The LATERAL resolves to the MOST RECENT settlement — the second charge, the
    // one that took the tab under. Ordering is load-bearing; a `LIMIT 1` with no
    // ORDER BY would hand the operator either row at Postgres's discretion.
    expect(found!.last_settlement_id).toBe(settlementIds[1])
    expect(found!.last_settlement_intent).toBe('pi_w1_1')
    expect(found!.last_settlement_pence).toBe(800)
  })

  it('a tab at zero or in debt is NOT an incident (no false positives)', async () => {
    // Owed but never settled — the ordinary state of every reading tab.
    await client.query(`UPDATE reading_tabs SET balance_pence = 800 WHERE id = $1`, [tabId])
    let { rows } = await client.query(NEGATIVE_READER_TAB_SQL)
    expect(rows.find((r) => r.account_id === readerId)).toBeUndefined()

    // Settled clean.
    await client.query(`UPDATE reading_tabs SET balance_pence = 0 WHERE id = $1`, [tabId])
    ;({ rows } = await client.query(NEGATIVE_READER_TAB_SQL))
    expect(rows.find((r) => r.account_id === readerId)).toBeUndefined()
  })

  it('detection is per-account: a second reader in credit is a second row, not a merged one', async () => {
    await doubleSettle(800)
    await client.query(
      `INSERT INTO reading_tabs (reader_id, balance_pence) VALUES ($1, -250)`,
      [otherReaderId],
    )

    const { rows } = await client.query(NEGATIVE_READER_TAB_SQL)
    const mine = rows.filter((r) => r.account_id === readerId || r.account_id === otherReaderId)
    expect(mine).toHaveLength(2)
    // Deepest credit first — a truncated sample must hold the most material rows.
    expect(mine[0].account_id).toBe(readerId)
    expect(mine[0].credit_pence).toBe(-800)
    expect(mine[1].credit_pence).toBe(-250)
    // A tab with no settlement at all still reports; the join is LEFT for exactly
    // this (the dispute-stake and subscription-credit-back paths can take a tab
    // negative with no settlement anywhere near it).
    expect(mine[1].last_settlement_id).toBeNull()
  })
})
