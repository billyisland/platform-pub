import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { ALLOCATION_COVERAGE_SQL } from '../src/services/allocation-coverage.js'

// =============================================================================
// PAYMENT-PERIMETER-ADR W2 — the tri-state half of the coverage metric, against
// a real Postgres.
//
// WHY DB-BACKED. The metric's whole crux is a three-way split of
// `tab_settlements.allocated_pence`: NULL means "never synced", 0 means "synced,
// and Stripe held nothing". Those are OPPOSITE facts, and the ADR names the
// trap exactly — an unallocated predicate written as a bare `IS NULL` would
// classify every settlement on the platform as an unsegregated charge, which
// pre-flip is all of them. Only Postgres evaluates that split; a mocked
// `pool.query` would answer it from a fixture I chose, and would stay green
// against the wrong predicate.
//
// THE CONTROL IS THE POINT. The naive `IS NULL` predicate is run over the SAME
// synthetic rows and asserted to give a DIFFERENT, wrong answer. Without that
// pair, "the shipped query returns 1 unallocated" proves nothing about whether
// the bug is present.
//
// MEASURED AS DELTAS. The shipped statement is unscoped by design (it is a
// platform-wide aggregate), so this runs it before and after the inserts and
// asserts the difference — which executes the REAL statement rather than a
// scoped rewrite of it, and is indifferent to whatever the target DB already
// holds.
//
// Runs inside a transaction that is ALWAYS rolled back, so the target DB is
// never mutated. Skipped unless a DB URL is supplied, so the no-Postgres CI
// `test` job stays green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/allocation-coverage-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

/**
 * Both predicates over the same rows, scoped to one synthetic reader so the
 * comparison is exact.
 *
 * The naive arm is a COPY of the bug the ADR names — the obvious way to write
 * "unallocated" — and the control's job is to show that it selects a DIFFERENT
 * population, not merely a different number.
 */
const PREDICATE_COMPARISON_SQL = `
  SELECT COALESCE(SUM(amount_pence) FILTER (
           WHERE allocation_synced_at IS NOT NULL AND allocated_pence = 0), 0)
           AS shipped_unallocated_pence,
         COALESCE(SUM(amount_pence) FILTER (WHERE allocated_pence IS NULL), 0)
           AS naive_unallocated_pence
    FROM tab_settlements
   WHERE status = 'completed'
     AND settled_at >= now() - make_interval(days => 30)
     AND reader_id = $1`

interface CoverageRow {
  measured_count: string
  measured_pence: string
  allocated_pence: string
  unallocated_count: string
  unallocated_pence: string
  unmeasured_count: string
  unmeasured_pence: string
}

describe.skipIf(!DB_URL)('allocation coverage counts the tri-state correctly (W2)', () => {
  let client: pg.Client
  let readerId: string
  let tabId: string

  const read = async (): Promise<Record<keyof CoverageRow, number>> => {
    const { rows } = await client.query<CoverageRow>(ALLOCATION_COVERAGE_SQL, [30])
    const r = rows[0]
    return {
      measured_count: parseInt(r.measured_count, 10),
      measured_pence: parseInt(r.measured_pence, 10),
      allocated_pence: parseInt(r.allocated_pence, 10),
      unallocated_count: parseInt(r.unallocated_count, 10),
      unallocated_pence: parseInt(r.unallocated_pence, 10),
      unmeasured_count: parseInt(r.unmeasured_count, 10),
      unmeasured_pence: parseInt(r.unmeasured_pence, 10),
    }
  }

  /** One settlement. `allocated` null ⇒ never synced (no timestamp either). */
  const settle = async (opts: {
    amountPence: number
    allocated: number | null
    status?: string
    daysAgo?: number
  }) => {
    const { rows } = await client.query(
      `INSERT INTO tab_settlements
         (reader_id, tab_id, amount_pence, platform_fee_pence, net_to_writers_pence,
          trigger_type, status, settled_at, allocated_pence, allocation_synced_at)
       VALUES ($1, $2, $3, 0, $3, 'threshold', $4,
               now() - make_interval(days => $5), $6,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [
        readerId,
        tabId,
        opts.amountPence,
        opts.status ?? 'completed',
        opts.daysAgo ?? 1,
        opts.allocated,
      ],
    )
    return rows[0].id as string
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await client.query('BEGIN')
    const stamp = `w2cov${Date.now()}`
    const { rows: acct } = await client.query(
      `INSERT INTO accounts (nostr_pubkey, username, display_name)
       VALUES ($1, $1, 'W2 coverage test') RETURNING id`,
      [stamp],
    )
    readerId = acct[0].id
    const { rows: tab } = await client.query(
      `INSERT INTO reading_tabs (reader_id) VALUES ($1) RETURNING id`,
      [readerId],
    )
    tabId = tab[0].id
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  it('splits synced-and-allocated, synced-and-zero, and never-synced three ways', async () => {
    const before = await read()

    await settle({ amountPence: 2000, allocated: 2000 }) // covered
    await settle({ amountPence: 1500, allocated: 0 }) // measured, uncovered
    await settle({ amountPence: 1000, allocated: null }) // never looked at

    const after = await read()

    // Measured = the two we read back. The never-synced row is in NEITHER the
    // numerator nor the denominator — that is the whole point.
    expect(after.measured_count - before.measured_count).toBe(2)
    expect(after.measured_pence - before.measured_pence).toBe(3500)
    expect(after.allocated_pence - before.allocated_pence).toBe(2000)

    // Uncovered = the measured-zero row alone, at its GROSS charge value — what
    // the platform held unsegregated, not the zero it was allocated.
    expect(after.unallocated_count - before.unallocated_count).toBe(1)
    expect(after.unallocated_pence - before.unallocated_pence).toBe(1500)

    // And the never-synced row is reported as its own third number, so a
    // coverage figure over a partial sample cannot read as one over all of it.
    expect(after.unmeasured_count - before.unmeasured_count).toBe(1)
    expect(after.unmeasured_pence - before.unmeasured_pence).toBe(1000)
  })

  it('CONTROL: the naive `IS NULL` predicate points at the opposite rows', async () => {
    await settle({ amountPence: 2000, allocated: 2000 })
    await settle({ amountPence: 1500, allocated: 0 })
    await settle({ amountPence: 1000, allocated: null })

    const { rows } = await client.query<{
      shipped_unallocated_pence: string
      naive_unallocated_pence: string
    }>(PREDICATE_COMPARISON_SQL, [readerId])

    // Both answer "one settlement, unallocated" — and they mean different
    // settlements. The shipped predicate means the £15.00 we looked at and
    // found nothing held against; the naive one means the £10.00 we have not
    // looked at yet, which has no answer either way. Same count, opposite fact,
    // and the populations do not intersect.
    expect(parseInt(rows[0].shipped_unallocated_pence, 10)).toBe(1500)
    expect(parseInt(rows[0].naive_unallocated_pence, 10)).toBe(1000)
  })

  it('CONTROL: pre-flip, the naive predicate calls the whole platform unsegregated', async () => {
    // The state the flag ships in: nothing synced, because `syncAllocations`
    // no-ops while STRIPE_ALLOCATED_FUNDS is off. The shipped predicate finds
    // NOTHING measured — an empty denominator, which `summariseCoverage` turns
    // into null and the panel renders as "no measured settlements yet". The
    // naive one finds every penny on the platform unallocated and would paint
    // the panel 0% every day until the flip.
    const before = await read()
    await settle({ amountPence: 2000, allocated: null })
    await settle({ amountPence: 3000, allocated: null })
    const after = await read()

    expect(after.measured_count - before.measured_count).toBe(0)
    expect(after.unallocated_pence - before.unallocated_pence).toBe(0)
    expect(after.unmeasured_pence - before.unmeasured_pence).toBe(5000)

    const { rows } = await client.query<{
      shipped_unallocated_pence: string
      naive_unallocated_pence: string
    }>(PREDICATE_COMPARISON_SQL, [readerId])
    expect(parseInt(rows[0].shipped_unallocated_pence, 10)).toBe(0)
    expect(parseInt(rows[0].naive_unallocated_pence, 10)).toBe(5000)
  })

  it('excludes settlements outside the window and settlements that never charged', async () => {
    const before = await read()

    await settle({ amountPence: 5000, allocated: 5000, daysAgo: 40 }) // out of window
    await settle({ amountPence: 700, allocated: 0, status: 'failed' }) // collected nothing
    await settle({ amountPence: 900, allocated: null, status: 'pending' }) // no charge yet

    const after = await read()

    expect(after.measured_count - before.measured_count).toBe(0)
    expect(after.measured_pence - before.measured_pence).toBe(0)
    expect(after.allocated_pence - before.allocated_pence).toBe(0)
    expect(after.unallocated_count - before.unallocated_count).toBe(0)
    // A pending row has no charge to allocate against, so it is not "awaiting a
    // read" either — it is not in the population at all.
    expect(after.unmeasured_count - before.unmeasured_count).toBe(0)
  })
})
