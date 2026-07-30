import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import type { PoolClient } from 'pg'
import {
  PUB_SPLIT_REPAY_CANDIDATES_SQL,
  PUB_SPLIT_MINT_REPLACEMENT_SQL,
  PUB_SPLIT_SUPERSEDE_SQL,
  PUB_SPLIT_REOPEN_PARENT_SQL,
  PUB_SPLIT_DISTRIBUTED_SQL,
  PUBLICATION_PAYOUT_COMPLETE_SQL,
} from '../src/services/payout.js'
import { prorateWithheldFee } from '../src/lib/allocation-packer.js'

// =============================================================================
// PUBLICATION-SPLIT RE-PAY — the replacement-row lifecycle, against a real
// Postgres.
//
// Queue item: CONSOLIDATED-TODO §1.2. Migration: 167.
//
// WHY THIS FILE EXISTS, AND WHY IT IS DB-BACKED. The re-pay is not really a
// branch; it is a set of PREDICATES. Whether a superseded row still counts, what
// the fee denominator sums over, whether a reopened parent re-completes, and —
// the one the whole design rests on — whether a replacement row is INVISIBLE to
// the three consumers that read this table, are all questions only Postgres can
// answer. A mocked `pool.query` would answer them from a fixture whose shape I
// chose, and would stay green against a `WHERE` clause that had silently
// changed. That is the failure mode CLAUDE.md's mock rule names.
//
// So this file imports the service's OWN statements and executes them. If a
// predicate changes in production it changes here, and a test that restated it
// would not have noticed.
//
// WHAT IT DOES NOT COVER, said out loud. `repayFailedPublicationSplits` drives
// the module-level `pool` and `withTransaction`, so — exactly like
// `executePendingChildren` — it is unreachable from inside this file's
// rolled-back transaction. The sweep's CONTROL FLOW (the attempt cap, the
// un-onboarded skip, the re-read-under-lock guard) is not proven here; what is
// proven is every statement it issues and every predicate those statements turn
// on. The Stripe call in between is pinned by the conformance batteries.
//
// It runs inside a transaction that is ALWAYS rolled back, so the target DB is
// never mutated. Skipped unless a DB URL is supplied, so the no-Postgres CI
// `test` job stays green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/publication-split-repay-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

describe.skipIf(!DB_URL)('publication-split re-pay', () => {
  let raw: pg.Client
  let client: PoolClient
  let memberId: string
  let readerId: string
  let publicationId: string

  beforeAll(async () => {
    raw = new pg.Client({ connectionString: DB_URL })
    await raw.connect()
    client = raw as unknown as PoolClient
  })
  afterAll(async () => {
    await raw.end()
  })

  beforeEach(async () => {
    await raw.query('BEGIN')
    memberId = await insertAccount()
    readerId = await insertAccount()
    publicationId = await insertPublication()
  })
  afterEach(async () => {
    await raw.query('ROLLBACK')
  })

  // --- fixtures -------------------------------------------------------------

  let seq = 0
  const uniq = () => `repay-${Date.now().toString(36)}-${seq++}`

  async function insertAccount(): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, '0')],
    )
    return rows[0].id
  }

  async function insertPublication(): Promise<string> {
    const s = uniq()
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO publications (name, slug, nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2, $3, 'x') RETURNING id`,
      [`Pub ${s}`, s, s.padEnd(64, '0')],
    )
    return rows[0].id
  }

  async function insertPayout(poolPence: number, feePence: number): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO publication_payouts
         (publication_id, total_pool_pence, platform_fee_pence, remaining_pool_pence, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [publicationId, poolPence, feePence, poolPence - feePence],
    )
    return rows[0].id
  }

  async function insertSplit(
    payoutId: string,
    amountPence: number,
    status: string,
    accountId = memberId,
  ): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO publication_payout_splits
         (publication_payout_id, account_id, share_bps, amount_pence, share_type, status)
       VALUES ($1, $2, 1000, $3, 'standing', $4) RETURNING id`,
      [payoutId, accountId, amountPence, status],
    )
    return rows[0].id
  }

  /** The sweep's own candidate query, run as production runs it. */
  async function candidates(): Promise<Array<Record<string, unknown>>> {
    const { rows } = await raw.query(PUB_SPLIT_REPAY_CANDIDATES_SQL)
    return rows as Array<Record<string, unknown>>
  }

  async function splitRow(id: string): Promise<{
    status: string
    attempt: number
    amount_pence: number
    share_bps: number | null
    share_type: string
    account_id: string
    replaced_by_split_id: string | null
  }> {
    const { rows } = await raw.query(
      `SELECT status, attempt, amount_pence, share_bps, share_type,
              account_id, replaced_by_split_id
         FROM publication_payout_splits WHERE id = $1`,
      [id],
    )
    return rows[0]
  }

  async function payoutStatus(id: string): Promise<{ status: string; completed_at: Date | null }> {
    const { rows } = await raw.query(
      `SELECT status, completed_at FROM publication_payouts WHERE id = $1`,
      [id],
    )
    return rows[0]
  }

  /**
   * Mint a replacement exactly as the sweep does: insert, then supersede. Both
   * statements are production's, in production's order.
   */
  async function mintReplacement(prev: {
    id: string
    payoutId: string
    accountId: string
    shareBps: number | null
    amountPence: number
    shareType: string
    attempt: number
  }): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(PUB_SPLIT_MINT_REPLACEMENT_SQL, [
      prev.payoutId,
      prev.accountId,
      prev.shareBps,
      prev.amountPence,
      prev.shareType,
      null,
      prev.attempt + 1,
    ])
    await raw.query(PUB_SPLIT_SUPERSEDE_SQL, [prev.id, rows[0].id])
    return rows[0].id
  }

  async function distributed(payoutId: string): Promise<number> {
    const { rows } = await raw.query<{ total: string }>(PUB_SPLIT_DISTRIBUTED_SQL, [payoutId])
    return parseInt(rows[0].total, 10)
  }

  // ---------------------------------------------------------------------------
  // The candidate set
  // ---------------------------------------------------------------------------

  it('selects a failed, un-superseded split and nothing else', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const failed = await insertSplit(payoutId, 500, 'failed')
    const pending = await insertSplit(payoutId, 500, 'pending')
    const completed = await insertSplit(payoutId, 500, 'completed')
    const reversed = await insertSplit(payoutId, 500, 'reversed')

    const ids = (await candidates()).map((r) => r.id)

    expect(ids).toContain(failed)
    // Each of these has a live claim on its money or is already paid; picking any
    // of them up would mint a second transfer for the same share.
    expect(ids).not.toContain(pending)
    expect(ids).not.toContain(completed)
    expect(ids).not.toContain(reversed)
  })

  it('drops a split once it has been superseded — the sweep cannot mint twice', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const failed = await insertSplit(payoutId, 500, 'failed')

    expect((await candidates()).map((r) => r.id)).toContain(failed)

    await mintReplacement({
      id: failed,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 500,
      shareType: 'standing',
      attempt: 1,
    })

    // This is the idempotency of the whole sweep: a crash after the mint, before
    // anything downstream, must not produce a second replacement on re-run.
    expect((await candidates()).map((r) => r.id)).not.toContain(failed)
  })

  it('ignores a zero-amount failed split', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const zero = await insertSplit(payoutId, 0, 'failed')
    expect((await candidates()).map((r) => r.id)).not.toContain(zero)
  })

  // ---------------------------------------------------------------------------
  // The replacement row
  // ---------------------------------------------------------------------------

  it('copies attribution verbatim and increments the attempt', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const failed = await insertSplit(payoutId, 750, 'failed')

    const replacementId = await mintReplacement({
      id: failed,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 750,
      shareType: 'standing',
      attempt: 1,
    })

    const replacement = await splitRow(replacementId)
    // Attribution is settled: computePublicationSplits is not reopened, so every
    // field that decides WHO GETS WHAT must come across unchanged. A re-pay that
    // recomputed would silently redistribute the pool.
    expect(replacement.amount_pence).toBe(750)
    expect(replacement.share_bps).toBe(1000)
    expect(replacement.share_type).toBe('standing')
    expect(replacement.account_id).toBe(memberId)
    expect(replacement.status).toBe('pending')
    expect(replacement.attempt).toBe(2)

    const predecessor = await splitRow(failed)
    expect(predecessor.status).toBe('failed')
    expect(predecessor.replaced_by_split_id).toBe(replacementId)
    expect(predecessor.attempt).toBe(1)
  })

  it('gives the replacement a different id, which is the whole point', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const failed = await insertSplit(payoutId, 750, 'failed')
    const replacementId = await mintReplacement({
      id: failed,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 750,
      shareType: 'standing',
      attempt: 1,
    })

    // The idempotency key is `pub-split-${payoutId}-${splitId}`. If the id were
    // reused the retry would dedupe straight back onto the rejected transfer,
    // which is the reason an in-place retry is impossible and this row exists.
    expect(replacementId).not.toBe(failed)
  })

  // ---------------------------------------------------------------------------
  // The fee-proration denominator
  // ---------------------------------------------------------------------------

  it('excludes superseded rows from the distributed total, so the fee does not drift', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    await insertSplit(payoutId, 400, 'completed')
    const failed = await insertSplit(payoutId, 600, 'failed')

    expect(await distributed(payoutId)).toBe(1000)

    await mintReplacement({
      id: failed,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 600,
      shareType: 'standing',
      attempt: 1,
    })

    // Unchanged: the replacement stands in its predecessor's place rather than
    // beside it. Counted both ways the total would be 1600, and the replacement's
    // prorated fee would come out BELOW the one the first attempt carried —
    // silently moving fee money on a path whose whole promise is that it moves
    // none.
    expect(await distributed(payoutId)).toBe(1000)
  })

  it('holds the replacement fee identical to its predecessor′s', async () => {
    const withheldFee = 1_000
    const payoutId = await insertPayout(10_000, withheldFee)
    await insertSplit(payoutId, 400, 'completed')
    const failed = await insertSplit(payoutId, 600, 'failed')

    const feeBefore = prorateWithheldFee(withheldFee, 600, await distributed(payoutId))

    await mintReplacement({
      id: failed,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 600,
      shareType: 'standing',
      attempt: 1,
    })

    const feeAfter = prorateWithheldFee(withheldFee, 600, await distributed(payoutId))
    expect(feeAfter).toBe(feeBefore)
  })

  // ---------------------------------------------------------------------------
  // The parent lifecycle
  // ---------------------------------------------------------------------------

  it('reopens a completed parent, and the completion rule closes it again', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const failed = await insertSplit(payoutId, 600, 'failed')
    await insertSplit(payoutId, 400, 'completed')

    // The parent legitimately completed: the rule is "no split PENDING", and a
    // failed split does not hold it open.
    await raw.query(PUBLICATION_PAYOUT_COMPLETE_SQL, [payoutId])
    expect((await payoutStatus(payoutId)).status).toBe('completed')

    const replacementId = await mintReplacement({
      id: failed,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 600,
      shareType: 'standing',
      attempt: 1,
    })
    await raw.query(PUB_SPLIT_REOPEN_PARENT_SQL, [payoutId])

    // Without this the resume sweep — which scans 'pending' parents only — would
    // never process the row just minted, and the replacement would sit pending
    // forever: a worse state than the failure it was meant to repair.
    const reopened = await payoutStatus(payoutId)
    expect(reopened.status).toBe('pending')
    expect(reopened.completed_at).toBeNull()

    // Completion is refused while the replacement is still pending…
    await raw.query(PUBLICATION_PAYOUT_COMPLETE_SQL, [payoutId])
    expect((await payoutStatus(payoutId)).status).toBe('pending')

    // …and granted once it pays, which is the loop closing.
    await raw.query(`UPDATE publication_payout_splits SET status = 'completed' WHERE id = $1`, [
      replacementId,
    ])
    await raw.query(PUBLICATION_PAYOUT_COMPLETE_SQL, [payoutId])
    expect((await payoutStatus(payoutId)).status).toBe('completed')
  })

  it('leaves an already-pending parent alone', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const before = await payoutStatus(payoutId)
    expect(before.status).toBe('pending')

    // Gated on status='completed' so a re-pay landing on a parent that is still
    // mid-cycle cannot clear a completed_at that was never set.
    const res = await raw.query(PUB_SPLIT_REOPEN_PARENT_SQL, [payoutId])
    expect(res.rowCount).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // The safety argument — the claim the whole design rests on.
  //
  // A replacement adds a row to a table three other money paths read. If any of
  // them counted it alongside its predecessor, a re-pay would double-report or
  // double-reverse a member's share. Each filters on status, so each should see
  // exactly one. These tests are that "should" made falsifiable.
  // ---------------------------------------------------------------------------

  it('is invisible to the distribution read model until it actually pays', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const failed = await insertSplit(payoutId, 600, 'failed')

    // ledger_publication_distribution sums LEDGER entries, and a failed split
    // posts none — the entry rides the pending→completed flip. So neither the
    // predecessor nor a pending replacement can appear.
    const distributedFor = async () => {
      const { rows } = await raw.query<{ distributed_pence: string | null }>(
        `SELECT distributed_pence FROM ledger_publication_distribution
          WHERE publication_id = $1`,
        [publicationId],
      )
      return rows.length === 0 ? 0 : parseInt(rows[0].distributed_pence ?? '0', 10)
    }

    expect(await distributedFor()).toBe(0)
    await mintReplacement({
      id: failed,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 600,
      shareType: 'standing',
      attempt: 1,
    })
    expect(await distributedFor()).toBe(0)
  })

  it('is counted exactly once by the settlement distribution read', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const failed = await insertSplit(payoutId, 600, 'failed')

    // settlement.ts's read selects status IN ('initiated','completed'). The
    // predecessor is 'failed' and the replacement 'pending', so during the window
    // between minting and paying the member's share is counted ZERO times…
    const seen = async () => {
      const { rows } = await raw.query<{ amount_pence: number }>(
        `SELECT amount_pence FROM publication_payout_splits
          WHERE publication_payout_id = $1
            AND status IN ('initiated', 'completed')`,
        [payoutId],
      )
      return rows.map((r) => r.amount_pence)
    }

    expect(await seen()).toEqual([])
    const replacementId = await mintReplacement({
      id: failed,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 600,
      shareType: 'standing',
      attempt: 1,
    })
    expect(await seen()).toEqual([])

    // …and ONCE after it pays. Never twice, which is the thing that would make a
    // re-pay over-report the pool.
    await raw.query(`UPDATE publication_payout_splits SET status = 'completed' WHERE id = $1`, [
      replacementId,
    ])
    expect(await seen()).toEqual([600])
  })

  it('is reversed exactly once by the F5 chargeback selection', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const failed = await insertSplit(payoutId, 600, 'failed')
    const replacementId = await mintReplacement({
      id: failed,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 600,
      shareType: 'standing',
      attempt: 1,
    })
    await raw.query(
      `UPDATE publication_payout_splits
          SET status = 'completed', stripe_transfer_id = $2 WHERE id = $1`,
      [replacementId, `tr_${uniq()}`],
    )

    // The chargeback planner prorates across PAID splits — status IN
    // ('completed','reversed'). A superseded predecessor sitting at 'failed' is
    // excluded, so a chargeback claws back the 600 that was actually paid rather
    // than 1200 against a member who received it once.
    const { rows } = await raw.query<{ id: string; amount_pence: number }>(
      `SELECT id, amount_pence FROM publication_payout_splits
        WHERE publication_payout_id = $1
          AND status IN ('completed', 'reversed')`,
      [payoutId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(replacementId)
    expect(rows[0].amount_pence).toBe(600)
  })

  // ---------------------------------------------------------------------------
  // The retry chain
  // ---------------------------------------------------------------------------

  it('walks a chain of attempts, each pointing at its successor', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    const first = await insertSplit(payoutId, 600, 'failed')

    const second = await mintReplacement({
      id: first,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 600,
      shareType: 'standing',
      attempt: 1,
    })
    await raw.query(`UPDATE publication_payout_splits SET status = 'failed' WHERE id = $1`, [second])

    const third = await mintReplacement({
      id: second,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 600,
      shareType: 'standing',
      attempt: 2,
    })

    expect((await splitRow(first)).replaced_by_split_id).toBe(second)
    expect((await splitRow(second)).replaced_by_split_id).toBe(third)
    expect((await splitRow(third)).attempt).toBe(3)

    // At attempt 3 the sweep's cap (PUB_SPLIT_MAX_ATTEMPTS) refuses to mint
    // again, so a permanently unpayable destination stops costing a Stripe call
    // and a row every cycle. The candidate query still surfaces it — the cap is
    // the sweep's judgement, not the query's — which is what lets the sweep log
    // it loudly for a human instead of dropping it silently.
    await raw.query(`UPDATE publication_payout_splits SET status = 'failed' WHERE id = $1`, [third])
    const stillCandidate = (await candidates()).find((r) => r.id === third)
    expect(stillCandidate).toBeDefined()
    expect(stillCandidate?.attempt).toBe(3)
  })

  it('keeps two splits for one account distinct — the collision that forced a row-stable key', async () => {
    const payoutId = await insertPayout(10_000, 1_000)
    // computePublicationSplits can legally emit two splits for one account in one
    // payout (a standing member who also holds an article share). This is why
    // supersession is an explicit pointer rather than a match on
    // (payout, account, share_type): inferred, re-paying one would look like
    // re-paying both.
    const standing = await insertSplit(payoutId, 600, 'failed')
    const article = await insertSplit(payoutId, 300, 'failed')

    await mintReplacement({
      id: standing,
      payoutId,
      accountId: memberId,
      shareBps: 1000,
      amountPence: 600,
      shareType: 'standing',
      attempt: 1,
    })

    const ids = (await candidates()).map((r) => r.id)
    expect(ids).not.toContain(standing)
    expect(ids).toContain(article)
  })
})
