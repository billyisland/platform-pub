import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import {
  PUBLICATION_CLAIM_READS_SQL,
  PUBLICATION_FINALISE_READS_SQL,
} from '../src/services/payout.js'

// =============================================================================
// The publication pool's claim over its reads — migration 168.
//
// WHY THIS FILE EXISTS. Until 2026-07-31 the publication payout cycle could not
// pay a read-funded pool AT ALL, and had never been able to.
// `reservePublicationPayout` claimed with
// `UPDATE read_events SET writer_payout_id = $1` where `$1` is a
// `publication_payouts` id, while that column carries
// `fk_read_events_writer_payout REFERENCES writer_payouts(id)`. Every claim
// raised 23503 and rolled the reserve back. The cycle catches per-publication
// errors and logs, so it failed SILENTLY: publications were simply never paid.
//
// It survived because NOTHING drove this cycle against a real database. The unit
// tests exercise `computePublicationSplits` (a pure function, which cannot see a
// constraint) and the ordering constants (SQL, but SELECTs, which cannot violate
// one). `publication-share-order-integration.test.ts` says so in its own header:
// "runPublicationPayoutCycle, which no unit test calls". Every test passed and
// the feature had never once run — component != feature.
//
// So the test that matters is not another assertion about splits. It is: does
// the claim actually land in Postgres. This file runs the EXPORTED statements —
// the same text production executes, not a copy that can drift — against a live
// database, with real FKs.
//
// THE PAIRED CONTROL IS THE POINT. Test 2 runs the PRE-FIX statement and asserts
// it still raises 23503. Without it, this file would pass just as well against a
// schema where the FK had been quietly dropped, and would be pinning nothing: a
// fix is only meaningful if the bug it fixes is demonstrably real. Mutate the
// production constant back to `writer_payout_id` and tests 1, 3, 4 and 5 go red.
//
// Rows are seeded inside a transaction that is ALWAYS rolled back, so the target
// database is never mutated. Skipped unless a DB URL is supplied, so the
// no-Postgres CI `test` job stays green. Run locally:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/publication-claim-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

/** The statement as it stood before migration 168 — the bug, preserved. */
const PRE_FIX_CLAIM_SQL = `
  UPDATE read_events
     SET writer_payout_id = $1
   WHERE read_events.publication_id = $2
     AND read_events.state = 'platform_settled'
     AND read_events.writer_payout_id IS NULL
  RETURNING chargeable_pence, tab_settlement_id`

describe.skipIf(!DB_URL)('publication pool — claiming its reads (migration 168)', () => {
  let client: pg.Client
  let pubId: string
  let writerId: string
  let readerId: string
  let articleId: string
  let tabId: string
  let payoutId: string

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await client.query('BEGIN')

    const acct = async (name: string) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts (nostr_pubkey, username, display_name)
              VALUES (md5(random()::text || $1), $1, $1) RETURNING id`,
        [`pubclaim-${name}-${Math.floor(Math.random() * 1e9)}`],
      )
      return rows[0].id
    }
    writerId = await acct('writer')
    readerId = await acct('reader')

    const { rows: pubRows } = await client.query<{ id: string }>(
      `INSERT INTO publications (slug, name, nostr_pubkey, nostr_privkey_enc)
            VALUES ($1, 'Claim Test', md5(random()::text), 'x') RETURNING id`,
      [`pubclaim-${Math.floor(Math.random() * 1e9)}`],
    )
    pubId = pubRows[0].id

    const { rows: artRows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, publication_id, title, slug, nostr_d_tag,
                            nostr_event_id, access_mode)
            VALUES ($1, $2, 'Claim test article', $3, $3, md5(random()::text), 'public')
         RETURNING id`,
      [writerId, pubId, `claim-${Math.floor(Math.random() * 1e9)}`],
    )
    articleId = artRows[0].id

    const { rows: tabRows } = await client.query<{ id: string }>(
      `INSERT INTO reading_tabs (reader_id, balance_pence) VALUES ($1, 0) RETURNING id`,
      [readerId],
    )
    tabId = tabRows[0].id

    const { rows: payoutRows } = await client.query<{ id: string }>(
      `INSERT INTO publication_payouts
         (publication_id, total_pool_pence, platform_fee_pence, remaining_pool_pence)
       VALUES ($1, 1000, 80, 920) RETURNING id`,
      [pubId],
    )
    payoutId = payoutRows[0].id
  })

  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  /** A settled publication read, ready to be claimed. */
  const seedRead = async (amountPence = 500): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO read_events
         (reader_id, article_id, writer_id, tab_id, publication_id,
          amount_pence, state, reader_pubkey_hash)
       VALUES ($1, $2, $3, $4, $5, $6, 'platform_settled', md5(random()::text))
       RETURNING id`,
      [readerId, articleId, writerId, tabId, pubId, amountPence],
    )
    return rows[0].id
  }

  it('claims the pool reads — the statement production runs, against real constraints', async () => {
    await seedRead(500)
    await seedRead(300)

    const { rows } = await client.query(PUBLICATION_CLAIM_READS_SQL, [payoutId, pubId])

    expect(rows).toHaveLength(2)
    expect(rows.map((r: any) => r.chargeable_pence).sort()).toEqual([300, 500])

    const { rows: stamped } = await client.query(
      `SELECT publication_payout_id, writer_payout_id FROM read_events
        WHERE publication_id = $1`,
      [pubId],
    )
    // Both halves matter: the pool's column is set, and the WRITER's is left
    // alone. The two cycles are exact complements, so a read claimed by the pool
    // must stay invisible to the writer cycle's `writer_payout_id IS NULL`
    // eligibility test — otherwise it would be paid twice.
    expect(stamped.every((r: any) => r.publication_payout_id === payoutId)).toBe(true)
    expect(stamped.every((r: any) => r.writer_payout_id === null)).toBe(true)
  })

  it('PAIRED CONTROL: the pre-fix statement still raises 23503, so the bug was real', async () => {
    await seedRead(500)

    // A savepoint, because the failure aborts the surrounding transaction and
    // afterEach's ROLLBACK would otherwise be all that survives.
    await client.query('SAVEPOINT prefix')
    let code: string | null = null
    try {
      await client.query(PRE_FIX_CLAIM_SQL, [payoutId, pubId])
    } catch (err: any) {
      code = err?.code ?? null
    }
    await client.query('ROLLBACK TO SAVEPOINT prefix')

    expect(code).toBe('23503')
  })

  it('is idempotent — a second claim takes nothing, so two cycles cannot double-claim', async () => {
    await seedRead(500)

    const first = await client.query(PUBLICATION_CLAIM_READS_SQL, [payoutId, pubId])
    expect(first.rows).toHaveLength(1)

    const { rows: other } = await client.query<{ id: string }>(
      `INSERT INTO publication_payouts
         (publication_id, total_pool_pence, platform_fee_pence, remaining_pool_pence)
       VALUES ($1, 500, 40, 460) RETURNING id`,
      [pubId],
    )
    const second = await client.query(PUBLICATION_CLAIM_READS_SQL, [other[0].id, pubId])
    expect(second.rows).toHaveLength(0)
  })

  it('claims only settled reads, and only this publication\'s', async () => {
    await seedRead(500)

    // An accrued (unsettled) read of the same publication.
    await client.query(
      `INSERT INTO read_events
         (reader_id, article_id, writer_id, tab_id, publication_id,
          amount_pence, state, reader_pubkey_hash)
       VALUES ($1, $2, $3, $4, $5, 900, 'accrued', md5(random()::text))`,
      [readerId, articleId, writerId, tabId, pubId],
    )
    // A settled PERSONAL read by the same writer — the writer cycle's to pay.
    // This is the complement rule in its sharpest form: if the pool took it, the
    // writer would be robbed and the reader charged once for two payouts.
    const { rows: personalArt } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, title, slug, nostr_d_tag, nostr_event_id, access_mode)
            VALUES ($1, 'Personal', $2, $2, md5(random()::text), 'public') RETURNING id`,
      [writerId, `personal-${Math.floor(Math.random() * 1e9)}`],
    )
    await client.query(
      `INSERT INTO read_events
         (reader_id, article_id, writer_id, tab_id, publication_id,
          amount_pence, state, reader_pubkey_hash)
       VALUES ($1, $2, $3, $4, NULL, 700, 'platform_settled', md5(random()::text))`,
      [readerId, personalArt[0].id, writerId, tabId],
    )

    const { rows } = await client.query(PUBLICATION_CLAIM_READS_SQL, [payoutId, pubId])

    expect(rows).toHaveLength(1)
    expect(rows[0].chargeable_pence).toBe(500)
  })

  it('finalise advances exactly the reads this payout claimed', async () => {
    const claimed = await seedRead(500)
    await client.query(PUBLICATION_CLAIM_READS_SQL, [payoutId, pubId])

    // A second settled read claimed by a DIFFERENT payout of the same
    // publication — finalise must not touch it.
    const unrelated = await seedRead(400)
    const { rows: other } = await client.query<{ id: string }>(
      `INSERT INTO publication_payouts
         (publication_id, total_pool_pence, platform_fee_pence, remaining_pool_pence)
       VALUES ($1, 400, 32, 368) RETURNING id`,
      [pubId],
    )
    await client.query(PUBLICATION_CLAIM_READS_SQL, [other[0].id, pubId])

    await client.query(PUBLICATION_FINALISE_READS_SQL, [pubId, payoutId])

    const { rows: states } = await client.query<{ id: string; state: string }>(
      `SELECT id, state FROM read_events WHERE id = ANY($1::uuid[])`,
      [[claimed, unrelated]],
    )
    const byId = new Map(states.map((r) => [r.id, r.state]))
    expect(byId.get(claimed)).toBe('writer_paid')
    expect(byId.get(unrelated)).toBe('platform_settled')
  })
})
