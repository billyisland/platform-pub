import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { CONVERT_PROVISIONAL_READS_SQL } from '../src/services/accrual.js'
import { perReadNetPence } from '@platform-pub/shared/lib/per-read-net.js'

// =============================================================================
// "Free reads should remain free — we can't charge people for stuff we gave
// them as a gift." (product ruling 2026-07-29; migration 164)
//
// Why this file is DB-backed and not a unit test. The whole change is which
// COLUMN the money path reads: `chargeable_pence` (list price minus the
// free-allowance gift, a GENERATED column) instead of `amount_pence`. Every
// route/worker test in this repo mocks `pool.query` and dispatches on the query
// string, so a mock would answer from a fixture whose shape I chose — pinning
// the fixture, not the behaviour, and staying green against a service that had
// regressed to `amount_pence`. Only Postgres can evaluate a generated column,
// so only Postgres can prove this. (CLAUDE.md: "a mocked pool.query must answer
// from the SQL it is handed, wherever it can — and where it can't, the test
// says so out loud." This is a case where it can't.)
//
// It runs the REAL exported statement the service executes, inside a
// transaction that is ALWAYS rolled back, so the target DB is never mutated.
//
// THE CONTROL IS THE POINT. Each assertion is paired with the same rows read
// through `amount_pence` — the pre-fix expression — showing the reader would
// have been charged for the gift. That is what makes this a test of the fix
// rather than a restatement of it: revert accrual.ts to `amount_pence` and the
// primary assertions fail while the controls pass.
//
// Skipped unless a DB URL is supplied, so the no-Postgres CI `test` job stays
// green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/free-allowance-gift-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

const FEE = 800 // 8%

describe.skipIf(!DB_URL)('the free allowance is a gift, and a card does not revoke it', () => {
  let client: pg.Client
  let readerId: string
  let writerId: string
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
    readerId = await insertAccount()
    writerId = await insertAccount()
    tabId = await insertTab(readerId)
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  // --- fixtures -------------------------------------------------------------

  let seq = 0
  const uniq = () => `gift-${Date.now().toString(36)}-${seq++}`

  async function insertAccount(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, '0')],
    )
    return rows[0].id
  }

  async function insertTab(owner: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO reading_tabs (reader_id) VALUES ($1) RETURNING id`,
      [owner],
    )
    return rows[0].id
  }

  async function insertArticle(): Promise<string> {
    const s = uniq()
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [writerId, s.padEnd(64, '0'), s, `Article ${s}`, s],
    )
    return rows[0].id
  }

  /**
   * A card-less read exactly as `recordGatePass` writes one: state
   * 'provisional', no tab, and the F14 split recorded on the row.
   */
  async function insertProvisionalRead(
    listPricePence: number,
    allowanceConsumedPence: number,
  ): Promise<string> {
    const articleId = await insertArticle()
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO read_events
         (reader_id, article_id, writer_id, amount_pence, state,
          on_free_allowance, allowance_consumed_pence)
       VALUES ($1, $2, $3, $4, 'provisional', $5, $6)
       RETURNING id`,
      [
        readerId,
        articleId,
        writerId,
        listPricePence,
        allowanceConsumedPence > 0,
        allowanceConsumedPence,
      ],
    )
    return rows[0].id
  }

  /** The REAL claim statement the service runs when the reader attaches a card. */
  async function convert(): Promise<{ id: string; chargeable_pence: number }[]> {
    const { rows } = await client.query<{ id: string; chargeable_pence: number }>(
      CONVERT_PROVISIONAL_READS_SQL,
      [tabId, readerId],
    )
    return rows
  }

  /** The pre-fix expression, for the paired control. */
  async function listPriceOf(readIds: string[]): Promise<number> {
    const { rows } = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_pence), 0) AS total
         FROM read_events WHERE id = ANY($1::uuid[])`,
      [readIds],
    )
    return parseInt(rows[0].total, 10)
  }

  // --- the ruling -----------------------------------------------------------

  it('charges nothing for a wholly-gifted read, though it has a list price', async () => {
    // The default FREE_ALLOWANCE_FLOOR_PENCE = 0 case: the F3 hard gate only
    // lets a card-less read through when the allowance covers all of it, so
    // this is what essentially every converted read looks like in production.
    await insertProvisionalRead(150, 150)
    await insertProvisionalRead(300, 300)

    const converted = await convert()
    const charged = converted.reduce((s, r) => s + r.chargeable_pence, 0)

    expect(converted).toHaveLength(2)
    expect(charged).toBe(0)

    // CONTROL: the pre-fix path billed the full list price for the same rows.
    expect(await listPriceOf(converted.map((r) => r.id))).toBe(450)
  })

  it('charges only the uncovered remainder when the allowance ran out mid-read', async () => {
    // Reachable only under a negative FREE_ALLOWANCE_FLOOR_PENCE, but it is the
    // case the F14 split exists to model — 5p left against a 10p read gifts 5p
    // and charges 5p, rather than gifting or charging the whole thing.
    await insertProvisionalRead(1000, 500)

    const converted = await convert()

    expect(converted).toHaveLength(1)
    expect(converted[0].chargeable_pence).toBe(500)

    // CONTROL: the pre-fix path charged 1000 — the gift billed back in full.
    expect(await listPriceOf(converted.map((r) => r.id))).toBe(1000)
  })

  it('is unchanged for a read that consumed no allowance', async () => {
    // The card-holder shape (classifyRead sets allowanceConsumedPence = 0 when
    // hasCard). chargeable == amount identically, which is what makes the
    // 30-site sweep of the payout core inert for all existing money.
    await insertProvisionalRead(700, 0)

    const converted = await convert()

    expect(converted[0].chargeable_pence).toBe(700)
    expect(await listPriceOf(converted.map((r) => r.id))).toBe(700)
  })

  it('earns the writer nothing on a gifted read', async () => {
    // The other half of the ruling: the gift comes from the author, so the
    // platform must not pay a writer for pence no reader was ever charged.
    // Reproduces the settlement-time writer_accrual expression against the
    // same column the service now uses.
    await insertProvisionalRead(400, 400)
    const converted = await convert()

    const { rows } = await client.query<{ net: string }>(
      `SELECT COALESCE(SUM(chargeable_pence - FLOOR(chargeable_pence * $2 / 10000)), 0) AS net
         FROM read_events WHERE id = ANY($1::uuid[])`,
      [converted.map((r) => r.id), FEE],
    )
    expect(parseInt(rows[0].net, 10)).toBe(0)

    // CONTROL: on the list price the writer would have earned a real net.
    expect(perReadNetPence(400, FEE)).toBe(368)
  })

  it('leaves the whole population inert once converted', async () => {
    // Migration 164's own assertion, as a property: nothing that has left
    // 'provisional' may carry a gift, or the money path would restate settled
    // money the ledger already recorded at the list price.
    await insertProvisionalRead(150, 150)
    await convert()

    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM read_events
        WHERE reader_id = $1 AND state <> 'provisional'
          AND amount_pence <> chargeable_pence`,
      [readerId],
    )
    // The converted gift row DOES differ — it is the population the ruling
    // creates, and it is exactly why the migration scoped its assertion to
    // rows that existed BEFORE the fix. Post-fix rows are expected here.
    expect(parseInt(rows[0].n, 10)).toBe(1)
  })
})
