import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { LEDGER_ORPHAN_ATTRIBUTION_SQL } from '../src/services/reconcile-ledger.js'
import {
  WRITER_PAYOUT_ELIGIBILITY_SQL,
  TRIBUTE_PAYOUT_ELIGIBILITY_SQL,
  WRITER_PAYOUT_RESUME_SQL,
  TRIBUTE_PAYOUT_RESUME_SQL,
} from '../src/services/payout.js'

// =============================================================================
// PAYMENT-PERIMETER-ADR W4 — "a divergence in an attributable class halts that
// account's payouts and nobody else's". This is the DB half of the acceptance
// criterion; the severity/branching half (attributable → no global halt,
// unattributable → global halt, the escalation) is proved against a scripted
// client in `ledger-reconcile.test.ts`.
//
// WHY DB-BACKED, in three parts, each of which a mocked `pool.query` would have
// answered from a fixture I chose rather than from the rule:
//
//  1. THE ORPHAN PREDICATE. "The source row is gone" is a NOT EXISTS across six
//     tables. Only Postgres can tell a real orphan from a real live entry, and
//     the whole attribution rests on that distinction being drawn correctly.
//
//  2. THE EXCLUSION. The halt exclusion is a NOT EXISTS buried in a four-CTE
//     eligibility query with a threshold, a KYC gate and a carve. That it
//     removes the halted writer WITHOUT removing anyone else is a property of
//     how the predicate composes with the rest of that query — precisely what a
//     mock cannot evaluate, and the direction of failure (paying a halted
//     account, or freezing an innocent one) is silent either way.
//
//  3. FIRST-WRITER-WINS. `ON CONFLICT DO NOTHING` preserving the ORIGINAL
//     created_at is what makes the age escalation meaningful. A mock that
//     implements first-writer-wins in TypeScript is pinning my TypeScript, not
//     the constraint.
//
// THE CONTROL IS THE POINT, as in W1's test: every "the halted account is gone"
// assertion is paired with "the other account is still there". Without the
// pair, an exclusion that emptied the entire eligibility set would pass.
//
// Runs the REAL exported statements the service executes, inside a transaction
// that is ALWAYS rolled back, so the target DB is never mutated.
//
// Skipped unless a DB URL is supplied, so the no-Postgres CI `test` job stays
// green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/payout-halt-attribution-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

const THRESHOLD_PENCE = 100
const FEE_BPS = 800

describe.skipIf(!DB_URL)('per-account payout halt: attribution and exclusion (W4)', () => {
  let client: pg.Client
  let writerA: string // will be halted
  let writerB: string // the control — must keep being paid
  let reader: string

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client.end()
  })

  const mkAccount = async (tag: string, connect = true) => {
    const suffix = `${tag}${Date.now()}${Math.floor(process.hrtime()[1] / 1000)}`
    const { rows } = await client.query(
      `INSERT INTO accounts (nostr_pubkey, username, display_name,
                             stripe_connect_id, stripe_connect_kyc_complete)
       VALUES ($1, $1, 'W4 test', $2, $3) RETURNING id`,
      [`w4${suffix}`, connect ? `acct_w4_${suffix}` : null, connect],
    )
    return rows[0].id as string
  }

  const mkArticle = async (writerId: string, pence: number) => {
    const tag = `w4-${writerId.slice(0, 8)}-${Date.now()}${Math.floor(process.hrtime()[1] / 1000)}`
    const { rows } = await client.query(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug,
                             access_mode, price_pence)
       VALUES ($1, $2, $2, 'W4', $2, 'paywalled', $3) RETURNING id`,
      [writerId, tag, pence],
    )
    return rows[0].id as string
  }

  /**
   * A settled, unclaimed read: what makes a writer eligible for payout.
   * `chargeable_pence` is GENERATED from amount − allowance, so the free
   * allowance must be 0 here or the writer earns nothing and the eligibility
   * baseline this test rests on would be vacuous.
   */
  const mkSettledRead = async (writerId: string, pence: number) => {
    const articleId = await mkArticle(writerId, pence)
    const { rows } = await client.query(
      `INSERT INTO read_events (reader_id, writer_id, article_id, amount_pence,
                                allowance_consumed_pence, state)
       VALUES ($1, $2, $3, $4, 0, 'platform_settled') RETURNING id`,
      [reader, writerId, articleId, pence],
    )
    return { articleId, readEventId: rows[0].id as string }
  }

  beforeEach(async () => {
    await client.query('BEGIN')
    writerA = await mkAccount('a')
    writerB = await mkAccount('b')
    reader = await mkAccount('r', false)
  })

  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  const halt = (accountId: string, reason = 'orphaned writer_payout ledger entry') =>
    client.query(
      `INSERT INTO payouts_halted_accounts (account_id, mismatch_class, reason)
       VALUES ($1, 'ledger_orphans', $2)
       ON CONFLICT (account_id) DO NOTHING
       RETURNING account_id`,
      [accountId, reason],
    )

  const eligibleWriters = async () => {
    const { rows } = await client.query(WRITER_PAYOUT_ELIGIBILITY_SQL, [THRESHOLD_PENCE, FEE_BPS])
    return rows.map((r) => r.writer_id as string)
  }

  // ---------------------------------------------------------------------------
  // 1. The orphan predicate really attributes, and only where it honestly can.
  // ---------------------------------------------------------------------------

  it('an orphaned writer_payout entry is found and carries its account_id', async () => {
    // A ledger entry whose writer_payouts row does not exist. The ledger is
    // append-only and the source row is gone, so account_id is the ONLY handle
    // left on whose divergence this is — which is why W4 put it in the SELECT.
    const orphanRef = '00000000-0000-0000-0000-0000000000ff'
    const { rows: entry } = await client.query(
      `INSERT INTO ledger_entries (account_id, counterparty_id, amount_pence,
                                   trigger_type, ref_table, ref_id)
       VALUES ($1, NULL, 500, 'writer_payout', 'writer_payouts', $2) RETURNING id`,
      [writerA, orphanRef],
    )

    const { rows } = await client.query(LEDGER_ORPHAN_ATTRIBUTION_SQL)
    const found = rows.find((r) => r.ledger_id === entry[0].id)

    expect(found).toBeDefined()
    expect(found!.account_id).toBe(writerA)
    expect(found!.trigger_type).toBe('writer_payout')
  })

  it('a writer_payout entry whose row EXISTS is not an orphan (no false positives)', async () => {
    // The control for the check above. Without it, an attribution query that
    // returned every ledger entry would pass the previous test perfectly.
    const { rows: payout } = await client.query(
      `INSERT INTO writer_payouts (writer_id, amount_pence, stripe_connect_id, status)
       VALUES ($1, 500, 'acct_w4_control', 'completed') RETURNING id`,
      [writerA],
    )
    const { rows: entry } = await client.query(
      `INSERT INTO ledger_entries (account_id, counterparty_id, amount_pence,
                                   trigger_type, ref_table, ref_id)
       VALUES ($1, NULL, 500, 'writer_payout', 'writer_payouts', $2) RETURNING id`,
      [writerA, payout[0].id],
    )

    const { rows } = await client.query(LEDGER_ORPHAN_ATTRIBUTION_SQL)
    expect(rows.find((r) => r.ledger_id === entry[0].id)).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // 2. The exclusion: this writer stops, and ONLY this writer.
  // ---------------------------------------------------------------------------

  it('a halted writer leaves the eligibility set and an unhalted one stays in it', async () => {
    await mkSettledRead(writerA, 500)
    await mkSettledRead(writerB, 500)

    // Before: both are payable. This baseline is load-bearing — without it, a
    // fixture that never qualified either writer would make the exclusion
    // assertion below vacuously true.
    const before = await eligibleWriters()
    expect(before).toContain(writerA)
    expect(before).toContain(writerB)

    await halt(writerA)

    const after = await eligibleWriters()
    expect(after).not.toContain(writerA) // this writer's money stops…
    expect(after).toContain(writerB) // …and nobody else's does
  })

  it('resuming the account returns it to the eligibility set', async () => {
    await mkSettledRead(writerA, 500)
    await halt(writerA)
    expect(await eligibleWriters()).not.toContain(writerA)

    await client.query(`DELETE FROM payouts_halted_accounts WHERE account_id = $1`, [writerA])
    expect(await eligibleWriters()).toContain(writerA)
  })

  it('the tribute cycle excludes a halted INSPIRER, not a halted author', async () => {
    // The recipient of a tribute transfer is the inspirer. Halting the AUTHOR
    // must not freeze the inspirer's money — that would be the same
    // someone-else's-divergence category error W4 exists to end, and it is the
    // easiest thing to get backwards when both ids are in the same row.
    const author = writerB
    const inspirer = writerA
    const { articleId, readEventId } = await mkSettledRead(author, 500)
    const { rows: trib } = await client.query(
      `INSERT INTO tributes (author_account_id, resolved_account_id, article_id, status, percentage_bps)
       VALUES ($1, $2, $3, 'live', 1000) RETURNING id`,
      [author, inspirer, articleId],
    )
    await client.query(
      `INSERT INTO tribute_accruals (tribute_id, read_event_id, amount_pence, state)
       VALUES ($1, $2, 50, 'released')`,
      [trib[0].id, readEventId],
    )

    const eligible = async () => {
      const { rows } = await client.query(TRIBUTE_PAYOUT_ELIGIBILITY_SQL)
      return rows.map((r) => r.tribute_id as string)
    }

    expect(await eligible()).toContain(trib[0].id)

    // The AUTHOR halted: the inspirer is owed by us, not by the author, so the
    // tribute must still pay.
    await halt(author)
    expect(await eligible()).toContain(trib[0].id)

    // The INSPIRER halted: now the recipient is the diverging party.
    await halt(inspirer)
    expect(await eligible()).not.toContain(trib[0].id)
  })

  // ---------------------------------------------------------------------------
  // 2b. The resume sweeps: a stuck-pending row does not bypass the halt.
  //
  // The eligibility exclusion above gates NEW payouts; a row already reserved
  // by a crashed cycle re-enters through resumePending*Payouts instead — and a
  // crash mid-payout is exactly what produces both the orphaned ledger entry
  // that halts an account AND its stuck-pending row, so the two paths must
  // agree or the halt is theatre (§0q.1). Runs the sweeps' own exported SQL.
  // ---------------------------------------------------------------------------

  it('the writer resume sweep skips the halted writer and keeps the control', async () => {
    await client.query(
      `INSERT INTO writer_payouts (writer_id, amount_pence, stripe_connect_id, status)
       VALUES ($1, 500, 'acct_w4_stuck_a', 'pending'), ($2, 500, 'acct_w4_stuck_b', 'pending')`,
      [writerA, writerB],
    )

    const sweep = async () => {
      const { rows } = await client.query(WRITER_PAYOUT_RESUME_SQL)
      return rows.map((r) => r.writer_id as string)
    }

    // Baseline: both stuck rows are visible to the sweep. Load-bearing — an
    // exclusion that emptied the sweep entirely would pass the halt assertion.
    const before = await sweep()
    expect(before).toContain(writerA)
    expect(before).toContain(writerB)

    await halt(writerA)

    const after = await sweep()
    expect(after).not.toContain(writerA) // the halted account stays pending…
    expect(after).toContain(writerB) // …and the control still resumes
  })

  it('the tribute resume sweep excludes a halted INSPIRER, not a halted author', async () => {
    const author = writerB
    const inspirer = writerA
    const { articleId } = await mkSettledRead(author, 500)
    const { rows: trib } = await client.query(
      `INSERT INTO tributes (author_account_id, resolved_account_id, article_id, status, percentage_bps)
       VALUES ($1, $2, $3, 'live', 1000) RETURNING id`,
      [author, inspirer, articleId],
    )
    await client.query(
      `INSERT INTO tribute_payouts (tribute_id, inspirer_account_id, author_account_id, amount_pence, status)
       VALUES ($1, $2, $3, 50, 'pending')`,
      [trib[0].id, inspirer, author],
    )

    const sweep = async () => {
      const { rows } = await client.query(TRIBUTE_PAYOUT_RESUME_SQL)
      return rows.map((r) => r.tribute_id as string)
    }

    expect(await sweep()).toContain(trib[0].id)

    // The AUTHOR halted: the recipient of this transfer is the inspirer, so
    // the stuck row must still resume — the same category rule the tribute
    // eligibility test above pins, applied to the sweep.
    await halt(author)
    expect(await sweep()).toContain(trib[0].id)

    // The INSPIRER halted: now the recipient is the diverging party.
    await halt(inspirer)
    expect(await sweep()).not.toContain(trib[0].id)
  })

  // ---------------------------------------------------------------------------
  // 3. First-writer-wins, which is what makes the age escalation mean anything.
  // ---------------------------------------------------------------------------

  it('re-halting preserves the ORIGINAL reason and timestamp, and RETURNS nothing', async () => {
    const first = await halt(writerA, 'the first divergence')
    expect(first.rows).toHaveLength(1) // newly halted

    const { rows: original } = await client.query(
      `SELECT reason, created_at FROM payouts_halted_accounts WHERE account_id = $1`,
      [writerA],
    )

    // The ledger is append-only, so the same orphan re-detects on EVERY run
    // until a human acts. An upsert here would refresh created_at each time —
    // a fortnight-old halt would read as new and the escalation would never
    // fire, which is the exact failure mode the bound exists to end.
    const second = await halt(writerA, 'the same orphan, detected again')
    expect(second.rows).toHaveLength(0) // nothing newly halted

    const { rows: after } = await client.query(
      `SELECT reason, created_at FROM payouts_halted_accounts WHERE account_id = $1`,
      [writerA],
    )
    expect(after[0].reason).toBe('the first divergence')
    expect(+after[0].created_at).toBe(+original[0].created_at)
  })

  it('the halt is per-account: two halts are two rows', async () => {
    await halt(writerA)
    await halt(writerB)
    const { rows } = await client.query(
      `SELECT account_id FROM payouts_halted_accounts WHERE account_id = ANY($1::uuid[])`,
      [[writerA, writerB]],
    )
    expect(rows).toHaveLength(2)
  })
})
