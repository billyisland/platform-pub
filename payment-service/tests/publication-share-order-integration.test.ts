import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import {
  PUBLICATION_ARTICLE_SHARES_SQL,
  PUBLICATION_STANDING_MEMBERS_SQL,
  computePublicationSplits,
  type ArticleShare,
  type StandingMember,
} from '../src/services/payout.js'

// =============================================================================
// M4(b) — the publication reserve path's order-dependent reads.
//
// Why this file exists at all: computePublicationSplits funds an ALREADY-ORDERED
// array first-come-first-served out of a shared pool, so when the pool is short
// the SQL ORDER BY decides who gets paid — but the ordering lives in
// runPublicationPayoutCycle, which no unit test calls, and the pure function
// cannot see it. The fix was therefore unreachable from payout-math.test.ts: the
// ordering could be deleted and every unit test would stay green.
//
// So this runs the REAL SQL (the exported constants the cycle itself executes,
// not a copy) against a live Postgres, then feeds the rows it returns into the
// REAL pure function — the same composition production performs. Rows are seeded
// inside a transaction that is ALWAYS rolled back, so the target DB is never
// mutated.
//
// The controls are the point: each ordering test is paired with the same rows
// run through computePublicationSplits in the order an UNORDERED query could
// return them, showing a different and worse allocation. That is what proves the
// ORDER BY is load-bearing money logic rather than cosmetic tidiness.
//
// Skipped unless a DB URL is supplied, so the no-Postgres CI `test` job stays
// green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/publication-share-order-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

const FEE = 800 // 8%

describe.skipIf(!DB_URL)('publication reserve path — share ordering (M4)', () => {
  let client: pg.Client
  let pubId: string

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await client.query('BEGIN')
    pubId = await insertPublication()
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  // --- fixtures -------------------------------------------------------------

  let seq = 0
  const uniq = () => `m4-${Date.now().toString(36)}-${seq++}`

  async function insertAccount(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, '0')],
    )
    return rows[0].id
  }

  async function insertPublication(): Promise<string> {
    const s = uniq()
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO publications (slug, name, nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [s, `Pub ${s}`, s.padEnd(64, '0'), 'enc'],
    )
    return rows[0].id
  }

  async function insertArticle(writerId: string): Promise<string> {
    const s = uniq()
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [writerId, s.padEnd(64, '0'), s, `Article ${s}`, s],
    )
    return rows[0].id
  }

  /** An explicit id lets a test pin the (article_id, id) tiebreak deterministically. */
  async function insertShare(opts: {
    articleId: string
    accountId: string
    shareType: 'flat_fee_pence' | 'revenue_bps'
    shareValue: number
    id?: string
  }): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO publication_article_shares
         (id, publication_id, article_id, account_id, share_type, share_value)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)
       RETURNING id`,
      [opts.id ?? null, pubId, opts.articleId, opts.accountId, opts.shareType, opts.shareValue],
    )
    return rows[0].id
  }

  async function insertMember(accountId: string, bps: number, createdAt: string): Promise<void> {
    await client.query(
      `INSERT INTO publication_members (publication_id, account_id, role, revenue_share_bps, created_at)
       VALUES ($1, $2, 'contributor', $3, $4)`,
      [pubId, accountId, bps, createdAt],
    )
  }

  /** Exactly the mapping runPublicationPayoutCycle applies to the queried rows. */
  const toArticleShares = (rows: ArticleShareRow[]): ArticleShare[] =>
    rows.map((r) => ({
      id: r.id,
      articleId: r.article_id,
      accountId: r.account_id,
      shareType: r.share_type,
      shareValue: r.share_value,
      paidOut: r.paid_out,
    }))

  interface ArticleShareRow {
    id: string; article_id: string; account_id: string
    share_type: string; share_value: number; paid_out: boolean
  }

  const readShares = async (): Promise<ArticleShareRow[]> =>
    (await client.query<ArticleShareRow>(PUBLICATION_ARTICLE_SHARES_SQL, [pubId])).rows

  // --- article shares: flat fees before bps overrides ------------------------

  // NOTE on why this fixture is WIDE (8 rows across 4 articles) rather than the
  // obvious 2 rows: an unordered query's output order is not random, it is an
  // artefact of the plan — here a Hash Join building on publication_article_shares
  // and probing with articles. A 2-row fixture therefore has a ~50% chance of
  // coming back in the right order BY ACCIDENT, and it did: the first draft of
  // this test PASSED against a build with the ORDER BY deleted. It asserted a
  // true property while being incapable of detecting the fix's removal — the
  // exact false-negative this file exists to rule out. Across 8 scrambled rows an
  // incidental order matching the fully-sorted one is vanishingly unlikely, so
  // the assertion detects rather than coincides. Verified: with the ORDER BY
  // stripped this test fails.
  it('returns rows sorted by (share_type, article_id, id) — flat fees before bps overrides', async () => {
    const writer = await insertAccount()
    // Sequential: a single pg.Client cannot have two queries in flight.
    const articles: string[] = []
    for (let i = 0; i < 4; i++) articles.push(await insertArticle(writer))
    articles.sort()

    // Two shares per article (distinct accounts — (article_id, account_id) is
    // UNIQUE), inserted in an order that opposes the expected one: bps before
    // flat, and articles walked from the highest id down.
    const inserted: { id: string; articleId: string; shareType: string }[] = []
    for (const articleId of [...articles].reverse()) {
      for (const shareType of ['revenue_bps', 'flat_fee_pence'] as const) {
        const id = await insertShare({
          articleId, accountId: await insertAccount(), shareType,
          shareValue: shareType === 'revenue_bps' ? 1000 : 10,
        })
        inserted.push({ id, articleId, shareType })
      }
    }

    const expected = [...inserted].sort((a, b) =>
      a.shareType !== b.shareType ? a.shareType.localeCompare(b.shareType)
        : a.articleId !== b.articleId ? a.articleId.localeCompare(b.articleId)
          : a.id.localeCompare(b.id),
    )

    const rows = await readShares()
    expect(rows.map((r) => r.id)).toEqual(expected.map((e) => e.id))
    // …and the headline of that ordering: every flat fee precedes every override.
    expect(rows.map((r) => r.share_type)).toEqual([
      ...Array(4).fill('flat_fee_pence'), ...Array(4).fill('revenue_bps'),
    ])
  })

  it('THE MONEY PROPERTY: a short pool funds the flat fee, and the bps override takes what is left', async () => {
    // The composition production runs: real SQL → real pure function.
    // Pool = 1000 gross − 80 fee = 920. Flat fee 900, bps override wants 460.
    // Only one of them can be paid in full and the ORDER BY chooses which.
    //
    // Honest scope: with only two rows this test's own pass does NOT prove the
    // ORDER BY is present (see the wide fixture above for why — an unordered plan
    // can emit these two in either order). Its job is to prove the COMPOSITION —
    // that the ordered rows feed the allocator correctly end-to-end — while the
    // control at the bottom proves the ordering is load-bearing money logic. The
    // detector is the test above.
    const writer = await insertAccount()
    const art = await insertArticle(writer)
    const bpsAcct = await insertAccount()
    const flatAcct = await insertAccount()

    await insertShare({ articleId: art, accountId: bpsAcct, shareType: 'revenue_bps', shareValue: 5000 })
    await insertShare({ articleId: art, accountId: flatAcct, shareType: 'flat_fee_pence', shareValue: 900 })

    const ordered = toArticleShares(await readShares())
    const result = computePublicationSplits(1000, FEE, ordered, new Map([[art, 920]]), [])

    // Flat fee paid in full; the override clamped to the 20 remaining.
    expect(result.flatFeesPaidPence).toBe(900)
    expect(result.splits.find((s) => s.accountId === flatAcct)!.amountPence).toBe(900)
    expect(result.splits.find((s) => s.accountId === bpsAcct)!.amountPence).toBe(20)
    expect(result.splits.reduce((s, x) => s + x.amountPence, 0)).toBeLessThanOrEqual(920)

    // CONTROL — the same rows in the order an unordered query could hand back
    // (insert order). The bps override is funded first and the flat fee, now
    // unaffordable at 900 > 460 remaining, is SKIPPED entirely: the freelancer
    // is paid nothing. Same rows, same pool, different person paid. That is the
    // ORDER BY doing money work.
    const unordered = [...ordered].reverse()
    const control = computePublicationSplits(1000, FEE, unordered, new Map([[art, 920]]), [])
    expect(control.flatFeesPaidPence).toBe(0)
    expect(control.splits.find((s) => s.accountId === flatAcct)).toBeUndefined()
    expect(control.splits.find((s) => s.accountId === bpsAcct)!.amountPence).toBe(460)
  })

  it('id breaks the tie between flat fees on the SAME article', async () => {
    // The wide fixture above gives each (share_type, article_id) pair exactly one
    // row, so it never exercises the id tiebreak. Five rows here, pinned to known
    // ids and inserted in scrambled order, so this detects rather than coincides.
    const writer = await insertAccount()
    const art = await insertArticle(writer)
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '3fffffff-ffff-4fff-8fff-ffffffffffff',
      '7fffffff-ffff-4fff-8fff-ffffffffffff',
      'bfffffff-ffff-4fff-8fff-ffffffffffff',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ]
    const scrambled = [ids[3], ids[0], ids[4], ids[1], ids[2]]
    for (const id of scrambled) {
      await insertShare({
        articleId: art, accountId: await insertAccount(),
        shareType: 'flat_fee_pence', shareValue: 10, id,
      })
    }

    const rows = await readShares()
    expect(rows.map((r) => r.id)).toEqual(ids) // ascending, not insert order
  })

  it('excludes shares belonging to another publication', async () => {
    const writer = await insertAccount()
    const art = await insertArticle(writer)
    const acct = await insertAccount()
    await insertShare({ articleId: art, accountId: acct, shareType: 'flat_fee_pence', shareValue: 10 })

    const otherPub = pubId
    pubId = await insertPublication() // rebind so insertShare targets the new pub
    const art2 = await insertArticle(writer)
    const acct2 = await insertAccount()
    await insertShare({ articleId: art2, accountId: acct2, shareType: 'flat_fee_pence', shareValue: 10 })

    expect((await readShares()).map((r) => r.article_id)).toEqual([art2])
    pubId = otherPub
    expect((await readShares()).map((r) => r.article_id)).toEqual([art])
  })

  // --- standing members: seniority order under the Σ-bps clamp ---------------

  it('returns standing members oldest-first, so the clamp clips the JUNIOR member', async () => {
    const senior = await insertAccount()
    const junior = await insertAccount()
    // Σ = 12000 > 10000 — an over-allocated set the write path should prevent but
    // historical rows and racing edits can produce, which is why compute clamps.
    // Insert the junior FIRST so insertion order opposes seniority.
    await insertMember(junior, 4000, '2026-02-01T00:00:00Z')
    await insertMember(senior, 8000, '2026-01-01T00:00:00Z')

    const { rows } = await client.query<{ account_id: string; revenue_share_bps: number }>(
      PUBLICATION_STANDING_MEMBERS_SQL, [pubId],
    )
    expect(rows.map((r) => r.account_id)).toEqual([senior, junior])

    const members: StandingMember[] = rows.map((r) => ({
      accountId: r.account_id, revenueShareBps: r.revenue_share_bps,
    }))
    const result = computePublicationSplits(1000, FEE, [], new Map(), members)
    // Pool 920. Senior takes 8000bps = 736; junior is clamped to the remaining
    // 2000bps = 184, not its nominal 4000.
    expect(result.splits.find((s) => s.accountId === senior)!.amountPence).toBe(736)
    expect(result.splits.find((s) => s.accountId === junior)!.amountPence).toBe(184)
    expect(result.splits.reduce((s, x) => s + x.amountPence, 0)).toBeLessThanOrEqual(920)

    // CONTROL: reversed (what an unordered query could return) clips the SENIOR
    // member instead — 8000bps clamped to 6000. Same rows, different victim.
    const control = computePublicationSplits(1000, FEE, [], new Map(), [...members].reverse())
    expect(control.splits.find((s) => s.accountId === junior)!.amountPence).toBe(368)
    expect(control.splits.find((s) => s.accountId === senior)!.amountPence).toBe(552)
  })

  it('excludes removed members and zero-bps members', async () => {
    const active = await insertAccount()
    const removed = await insertAccount()
    const zero = await insertAccount()
    await insertMember(active, 5000, '2026-01-01T00:00:00Z')
    await insertMember(removed, 5000, '2026-01-02T00:00:00Z')
    await insertMember(zero, 0, '2026-01-03T00:00:00Z')
    await client.query(
      `UPDATE publication_members SET removed_at = now() WHERE publication_id = $1 AND account_id = $2`,
      [pubId, removed],
    )

    const { rows } = await client.query<{ account_id: string }>(
      PUBLICATION_STANDING_MEMBERS_SQL, [pubId],
    )
    expect(rows.map((r) => r.account_id)).toEqual([active])
  })
})
