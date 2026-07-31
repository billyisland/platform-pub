import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import type { PoolClient } from 'pg'
import {
  packUnits,
  prorateWithheldFee,
  prorateCarveReversal,
  type EarningUnit,
} from '../src/lib/allocation-packer.js'
import {
  PUBLICATION_PAYOUT_COMPLETE_SQL,
  TRIBUTE_CHILD_CARVE_SQL,
  TRIBUTE_CHILD_ADVANCE_SQL,
  TRIBUTE_CHILD_VOID_SQL,
  TRIBUTE_CHILD_RELEASE_SQL,
  TRIBUTE_CHILDLESS_ADVANCE_SQL,
} from '../src/services/payout.js'
import {
  ALLOCATION_DIVERGENCE_CANDIDATES_SQL,
  RESIDUAL_SHARE_SQL,
  summariseResidual,
  type DivergenceCandidate,
} from '../src/services/allocation-reconcile.js'
import { RECORD_REFUND_DRAW_SQL } from '../src/services/settlement.js'
import {
  lockFundingSources,
  insertChildren,
  failChild,
  reverseChild,
  completeParentIfSettled,
  type ChildRow,
} from '../src/services/payout-children.js'

// =============================================================================
// FUNDS SEGREGATION — the reserve→pack→children→complete ASSEMBLY, against a
// real Postgres.
//
// Spec: docs/adr/FUNDS-SEGREGATION-INTEGRATION.md §3.3b/§3.3c/§3.4/§3.5.
//
// WHY THIS FILE EXISTS. §10.3 states the gap plainly: "the packer is
// unit-tested and mutation-verified and the per-child reversal has seven tests
// … the flag-ON reserve→pack→execute→complete assembly has NO automated
// coverage." The packer is a pure function and is proven as one; what was never
// proven is that its output, once written down, actually adds up in the
// database — and that half is almost entirely SQL:
//
//   • the drawing budget is `GREATEST(0, allocated_pence − Σ draws)`, evaluated
//     by Postgres inside `lockFundingSources`
//   • one draw per child, and `failChild`'s single-statement DELETE that
//     RETURNS that allocation to the budget, is a row-grain claim
//   • the refund draw's idempotency is a UNIQUE (ref_table, ref_id, kind) and a
//     GREATEST upsert — a constraint, not a branch
//   • `completeParentIfSettled` tallies with `count(*) FILTER (…)` and restates
//     the parent's amount from `SUM(net_pence) FILTER (…)`
//
// A mocked `pool.query` cannot evaluate any of that. It would answer from a
// fixture whose shape I chose, and would stay green against arithmetic that had
// silently changed — which is the failure mode CLAUDE.md's mock rule names, and
// the reason the repo's other money-shaped proofs (the free-allowance gift, the
// publication share ordering) are DB-backed too.
//
// WHAT IT DOES NOT COVER, said out loud. `executePendingChildren` drives Stripe
// through the module-level `pool`, so it is not reachable from inside this
// file's rolled-back transaction; the Stripe-facing half of the loop (terminal
// vs ambiguous, the row-stable key, the flip-gated ledger emit) is pinned by
// the mock-based conformance batteries instead. This file proves the state the
// loop reads and writes, not the call it makes in between.
//
// It runs inside a transaction that is ALWAYS rolled back, so the target DB is
// never mutated. Skipped unless a DB URL is supplied, so the no-Postgres CI
// `test` job stays green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/segregation-assembly-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

const MAX_SLICES = 20

describe.skipIf(!DB_URL)('funds segregation — the flag-ON assembly', () => {
  let raw: pg.Client
  /** The same object; `payout-children` takes a PoolClient and uses only .query. */
  let client: PoolClient
  let readerId: string
  let writerId: string
  let tabId: string

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
    readerId = await insertAccount()
    writerId = await insertAccount()
    tabId = await insertTab(readerId)
  })
  afterEach(async () => {
    await raw.query('ROLLBACK')
  })

  // --- fixtures -------------------------------------------------------------

  let seq = 0
  const uniq = () => `seg-${Date.now().toString(36)}-${seq++}`

  async function insertAccount(): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, '0')],
    )
    return rows[0].id
  }

  async function insertTab(owner: string): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO reading_tabs (reader_id) VALUES ($1) RETURNING id`,
      [owner],
    )
    return rows[0].id
  }

  /**
   * A completed settlement carrying a known allocation — i.e. a charge the
   * packer may draw on. `allocated_pence` is what `syncAllocations` would have
   * stamped; NULL would mean "not known to be drawable" and is tested too.
   */
  async function insertSettlement(
    amountPence: number,
    allocatedPence: number | null,
  ): Promise<string> {
    const s = uniq()
    const { rows } = await raw.query<{ id: string }>(
      // The payment-intent id is what the §3.6 sweep re-reads from Stripe, so
      // it must be present or that sweep's candidate filter is never actually
      // exercised — every fixture would fall out of the query for the wrong
      // reason and its NOT NULL guards would test nothing.
      `INSERT INTO tab_settlements
         (reader_id, tab_id, amount_pence, platform_fee_pence, net_to_writers_pence,
          stripe_charge_id, stripe_payment_intent_id, trigger_type, status,
          allocated_pence, allocation_synced_at)
       VALUES ($1, $2, $3, 0, $3, $4, $5, 'threshold', 'completed', $6,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [readerId, tabId, amountPence, `ch_${s}`, `pi_${s}`, allocatedPence],
    )
    return rows[0].id
  }

  async function insertWriterPayout(amountPence: number): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO writer_payouts (writer_id, amount_pence, stripe_connect_id, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [writerId, amountPence, `acct_${uniq()}`],
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

  async function insertPublicationPayout(
    publicationId: string,
    poolPence: number,
    feePence: number,
  ): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO publication_payouts
         (publication_id, total_pool_pence, platform_fee_pence, remaining_pool_pence, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [publicationId, poolPence, feePence, poolPence - feePence],
    )
    return rows[0].id
  }

  async function insertSplit(payoutId: string, amountPence: number): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO publication_payout_splits
         (publication_payout_id, account_id, share_bps, amount_pence, share_type, status)
       VALUES ($1, $2, 1000, $3, 'standing', 'pending') RETURNING id`,
      [payoutId, writerId, amountPence],
    )
    return rows[0].id
  }

  // --- helpers --------------------------------------------------------------

  const unit = (
    id: string,
    netPence: number,
    feePence: number,
    preferred: string[] = [],
  ): EarningUnit => ({
    id,
    source: 'read_events',
    netPence,
    feePence,
    preferredSettlementIds: preferred,
  })

  /** The remainder as the NEXT pack would see it — the real SQL, not a copy. */
  async function remainderOf(settlementId: string): Promise<number> {
    const sources = await lockFundingSources(client, [settlementId])
    return sources[0]?.remainingPence ?? 0
  }

  async function childrenOf(parentTable: string, parentId: string): Promise<ChildRow[]> {
    const { rows } = await raw.query<ChildRow>(
      `SELECT id, parent_table, parent_id, settlement_id, stripe_charge_id,
              funding, net_pence, fee_pence, status, stripe_transfer_id
         FROM payout_transfers
        WHERE parent_table = $1 AND parent_id = $2
        ORDER BY id ASC`,
      [parentTable, parentId],
    )
    return rows
  }

  async function drawTotal(settlementId: string): Promise<number> {
    const { rows } = await raw.query<{ total: string }>(
      `SELECT COALESCE(SUM(gross_pence), 0) AS total
         FROM allocated_draws WHERE settlement_id = $1`,
      [settlementId],
    )
    return parseInt(rows[0].total, 10)
  }

  /** The service's OWN statement (§3.5), imported — not a copy of it. */
  async function recordRefundDraw(settlementId: string, amountPence: number) {
    await raw.query(RECORD_REFUND_DRAW_SQL, [settlementId, amountPence])
  }

  async function markCompleted(childId: string, transferId: string) {
    await raw.query(
      `UPDATE payout_transfers
          SET status = 'completed', stripe_transfer_id = $2, completed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [childId, transferId],
    )
  }

  // ==========================================================================
  // Zero-net units: the reserve wedge (review 2026-07-30, finding 4)
  // ==========================================================================

  describe('zero-net units never reach the child table', () => {
    it('the CHECK is real: a zero-net child is uninsertable (paired control)', async () => {
      // This is the DB half of the wedge: if a zero-net slice IS emitted, the
      // insert aborts the whole reserve transaction — and packing being
      // deterministic, the same writer aborts every cycle. The packer test
      // proves no such slice is emitted; this proves the gate it would hit.
      const payoutId = await insertWriterPayout(500)
      await expect(
        insertChildren(client, 'writer_payouts', payoutId, [
          {
            settlementId: null,
            stripeChargeId: null,
            funding: 'platform_balance',
            netPence: 0,
            feePence: 0,
            units: [],
          },
        ]),
      ).rejects.toMatchObject({ code: '23514' })
    })

    it('a claimed zero-net read is set aside, and the emitted slices insert clean', async () => {
      // The wedge shape: the zero-net unit's own settlement has room and no
      // other unit lands on it, so pre-fix it OPENED ITS OWN slice (gross 0
      // "fits" anything) with netPence 0 — the uninsertable child above.
      const giftedOwn = await insertSettlement(1000, 1000)
      const realOwn = await insertSettlement(1000, 1000)
      const payoutId = await insertWriterPayout(500)

      const sources = await lockFundingSources(client, [giftedOwn, realOwn])
      const { slices, zeroNet } = packUnits(
        [unit('gifted', 0, 0, [giftedOwn]), unit('real', 500, 40, [realOwn])],
        sources,
        { maxSlices: MAX_SLICES },
      )

      expect(zeroNet.map((u) => u.id)).toEqual(['gifted'])

      const childIds = await insertChildren(client, 'writer_payouts', payoutId, slices)
      expect(childIds).toHaveLength(1)

      const children = await childrenOf('writer_payouts', payoutId)
      expect(children).toHaveLength(1)
      expect(children[0].settlement_id).toBe(realOwn)
      expect(children[0].net_pence).toBe(500)
    })
  })

  // ==========================================================================
  // The budget: what the packer is told is drawable
  // ==========================================================================

  describe('the drawing budget', () => {
    it('offers the full allocation before anything is drawn, and only completed, allocation-known charges', async () => {
      const funded = await insertSettlement(5000, 5000)
      const unknown = await insertSettlement(5000, null) // never synced
      const sources = await lockFundingSources(client, [funded, unknown])

      // NULL allocated_pence means "not known to be drawable" and is the safe
      // default — never assumed. Its absence here is the whole guarantee: a
      // charge we have not read back cannot fund a transfer.
      expect(sources.map((s) => s.settlementId)).toEqual([funded])
      expect(sources[0].remainingPence).toBe(5000)
    })

    it('falls by exactly the GROSS of each child — net PLUS fee, not net alone', async () => {
      // Stripe debits the application fee from the SAME allocated balance as the
      // transfer, so the pair is what the charge must fund. A budget that
      // decremented by net alone would over-offer by the fee on every draw and
      // the last transfer of a cycle would be rejected.
      const settlement = await insertSettlement(5000, 5000)
      const payoutId = await insertWriterPayout(920)

      const sources = await lockFundingSources(client, [settlement])
      const { slices } = packUnits([unit('u1', 920, 80, [settlement])], sources, {
        maxSlices: MAX_SLICES,
      })
      await insertChildren(client, 'writer_payouts', payoutId, slices)

      expect(await drawTotal(settlement)).toBe(1000) // 920 + 80
      expect(await remainderOf(settlement)).toBe(4000)
    })

    it('never goes negative, and an over-drawn charge simply stops funding', async () => {
      const settlement = await insertSettlement(1000, 1000)
      await recordRefundDraw(settlement, 4000) // a refund larger than the allocation

      expect(await remainderOf(settlement)).toBe(0)
      // Not merely clamped in the read: the source drops out of the candidate
      // set entirely, so the packer routes to another charge or the residual.
      const sources = await lockFundingSources(client, [settlement])
      expect(sources).toEqual([])
    })
  })

  // ==========================================================================
  // §3.5 — the refund hook, which is the flip blocker
  // ==========================================================================

  describe('a refund draws down the budget (§3.5)', () => {
    it('makes a PARTIAL refund visible to the packer, which is the wedge it closes', async () => {
      // The bug: a partial refund takes money out of the charge's segregated
      // balance, and before this hook our model never learned. Stripe's number
      // fell, ours did not, and the next payout packed a slice the charge could
      // no longer fund.
      const settlement = await insertSettlement(5000, 5000)
      const payoutId = await insertWriterPayout(4500)

      await recordRefundDraw(settlement, 3000) // reader refunded £30 of £50

      const sources = await lockFundingSources(client, [settlement])
      expect(sources[0].remainingPence).toBe(2000)

      // 4500 no longer fits the drained charge, so it routes to the residual
      // rather than being packed onto a charge that would reject it.
      const { slices } = packUnits([unit('u1', 4500, 0, [settlement])], sources, {
        maxSlices: MAX_SLICES,
      })
      expect(slices).toHaveLength(1)
      expect(slices[0].funding).toBe('platform_balance')

      await insertChildren(client, 'writer_payouts', payoutId, slices)
      const children = await childrenOf('writer_payouts', payoutId)
      expect(children[0].settlement_id).toBeNull()
      // A residual child draws nothing — there is no allocation behind it.
      expect(await drawTotal(settlement)).toBe(3000)
    })

    it('is idempotent under redelivery and MONOTONE under out-of-order delivery', async () => {
      // Stripe reports `amount_refunded` CUMULATIVELY, so a second partial is a
      // larger absolute figure rather than an increment — hence GREATEST rather
      // than accumulation. And webhook delivery is not ordered, so a redelivery
      // of the FIRST partial must not shrink the budget back.
      const settlement = await insertSettlement(5000, 5000)

      await recordRefundDraw(settlement, 1000)
      await recordRefundDraw(settlement, 1000) // redelivery
      expect(await drawTotal(settlement)).toBe(1000) // not 2000

      await recordRefundDraw(settlement, 2500) // a second, larger partial
      expect(await drawTotal(settlement)).toBe(2500)

      await recordRefundDraw(settlement, 1000) // the FIRST, arriving late
      expect(await drawTotal(settlement)).toBe(2500) // monotone — never regresses

      expect(await remainderOf(settlement)).toBe(2500)
    })
  })

  // ==========================================================================
  // §3.3c — the child lifecycle
  // ==========================================================================

  describe('the child lifecycle', () => {
    it('packs one child per charge drawn on, and the parent restates to what actually paid', async () => {
      const s1 = await insertSettlement(1000, 1000)
      const s2 = await insertSettlement(1000, 1000)
      const payoutId = await insertWriterPayout(1800)

      const sources = await lockFundingSources(client, [s1, s2])
      const { slices, overflow } = packUnits(
        [unit('r1', 900, 100, [s1]), unit('r2', 900, 100, [s2])],
        sources,
        { maxSlices: MAX_SLICES },
      )
      expect(overflow).toHaveLength(0)
      expect(slices).toHaveLength(2)

      await insertChildren(client, 'writer_payouts', payoutId, slices)
      const children = await childrenOf('writer_payouts', payoutId)
      expect(children).toHaveLength(2)
      expect(children.every((c) => c.funding === 'allocated')).toBe(true)

      // Both charges fully drawn — the pair is 900 + 100 each.
      expect(await remainderOf(s1)).toBe(0)
      expect(await remainderOf(s2)).toBe(0)

      // Still pending ⇒ the parent must NOT complete.
      const early = await completeParentIfSettled(client, 'writer_payouts', payoutId)
      expect(early.completed).toBe(false)
      expect(early.paidPence).toBe(0)

      await markCompleted(children[0].id, 'tr_1')
      await markCompleted(children[1].id, 'tr_2')

      const done = await completeParentIfSettled(client, 'writer_payouts', payoutId)
      expect(done.completed).toBe(true)
      expect(done.paidPence).toBe(1800)

      const { rows } = await raw.query<{ status: string; amount_pence: number }>(
        `SELECT status, amount_pence FROM writer_payouts WHERE id = $1`,
        [payoutId],
      )
      expect(rows[0].status).toBe('completed')
      expect(rows[0].amount_pence).toBe(1800)
    })

    it('returns a failed child\'s allocation to the budget, and restates the parent smaller', async () => {
      // The point of the whole child design: ONE Stripe rejection out of N is an
      // ordinary event, not a wedged payout. The failed child's units go back
      // for re-pay next cycle and its charge goes back to funding others.
      const s1 = await insertSettlement(1000, 1000)
      const s2 = await insertSettlement(1000, 1000)
      const payoutId = await insertWriterPayout(1800)

      const sources = await lockFundingSources(client, [s1, s2])
      const { slices } = packUnits(
        [unit('r1', 900, 100, [s1]), unit('r2', 900, 100, [s2])],
        sources,
        { maxSlices: MAX_SLICES },
      )
      await insertChildren(client, 'writer_payouts', payoutId, slices)
      const children = await childrenOf('writer_payouts', payoutId)

      await markCompleted(children[0].id, 'tr_1')
      expect(await failChild(client, children[1].id, 'transfer_rejected')).toBe(true)

      // The draw is GONE, so the charge is whole again.
      expect(await remainderOf(children[1].settlement_id!)).toBe(1000)

      const done = await completeParentIfSettled(client, 'writer_payouts', payoutId)
      expect(done.completed).toBe(true)
      expect(done.paidPence).toBe(900) // NOT the reserved 1800
      expect(done.failedCount).toBe(1)

      const { rows } = await raw.query<{ status: string; amount_pence: number; failed_reason: string | null }>(
        `SELECT status, amount_pence, failed_reason FROM writer_payouts WHERE id = $1`,
        [payoutId],
      )
      expect(rows[0].status).toBe('completed')
      expect(rows[0].amount_pence).toBe(900) // ledger parity holds by construction
      expect(rows[0].failed_reason).toContain('1 child')
    })

    it('fails a parent OUTRIGHT when every child failed, rather than leaving a zombie', async () => {
      // §10.2 divergence 2. Leaving it 'pending' would recreate exactly the
      // publication zombie this design exists to avoid: the resume sweep would
      // revisit it every cycle, find no pending child, and never resolve it.
      const s1 = await insertSettlement(1000, 1000)
      const payoutId = await insertWriterPayout(900)

      const sources = await lockFundingSources(client, [s1])
      const { slices } = packUnits([unit('r1', 900, 100, [s1])], sources, {
        maxSlices: MAX_SLICES,
      })
      await insertChildren(client, 'writer_payouts', payoutId, slices)
      const children = await childrenOf('writer_payouts', payoutId)

      await failChild(client, children[0].id, 'transfer_rejected')

      const done = await completeParentIfSettled(client, 'writer_payouts', payoutId)
      expect(done.completed).toBe(false)
      expect(done.failedOutright).toBe(true)

      const { rows } = await raw.query<{ status: string; completed_at: Date | null }>(
        `SELECT status, completed_at FROM writer_payouts WHERE id = $1`,
        [payoutId],
      )
      expect(rows[0].status).toBe('failed')
      expect(rows[0].completed_at).toBeNull()
    })

    it('refuses to re-fail a completed child, so a stray webhook cannot unwind a paid transfer', async () => {
      const s1 = await insertSettlement(1000, 1000)
      const payoutId = await insertWriterPayout(900)
      const sources = await lockFundingSources(client, [s1])
      const { slices } = packUnits([unit('r1', 900, 100, [s1])], sources, {
        maxSlices: MAX_SLICES,
      })
      await insertChildren(client, 'writer_payouts', payoutId, slices)
      const [child] = await childrenOf('writer_payouts', payoutId)

      await markCompleted(child.id, 'tr_1')

      // The guard is status = 'pending', never merely <> 'completed'.
      expect(await failChild(client, child.id, 'stray webhook')).toBe(false)
      expect(await drawTotal(s1)).toBe(1000) // the draw survives
    })
  })

  // ==========================================================================
  // §3.5 — per-child reversal
  // ==========================================================================

  describe('per-child reversal', () => {
    it('posts only the DELTA of a cumulative partial, and returns it to the allocation', async () => {
      const s1 = await insertSettlement(2000, 2000)
      const payoutId = await insertWriterPayout(1000)
      const sources = await lockFundingSources(client, [s1])
      const { slices } = packUnits([unit('r1', 1000, 0, [s1])], sources, {
        maxSlices: MAX_SLICES,
      })
      await insertChildren(client, 'writer_payouts', payoutId, slices)
      const [child] = await childrenOf('writer_payouts', payoutId)
      await markCompleted(child.id, 'tr_1')

      const fresh = (await childrenOf('writer_payouts', payoutId))[0]

      expect(await reverseChild(client, fresh, 400)).toBe(400)
      expect(await reverseChild(client, fresh, 400)).toBe(0) // redelivery
      expect(await reverseChild(client, fresh, 700)).toBe(300) // staged partial

      const { rows } = await raw.query<{ status: string; reversed_pence: number }>(
        `SELECT status, reversed_pence FROM payout_transfers WHERE id = $1`,
        [child.id],
      )
      expect(rows[0].reversed_pence).toBe(700)
      expect(rows[0].status).toBe('completed') // not fully reversed yet

      // Reversed funds return to the ALLOCATED state, not to platform balance,
      // so the budget grows back by exactly what came back: drew 1000, 700 back.
      expect(await drawTotal(s1)).toBe(300)
      expect(await remainderOf(s1)).toBe(1700)

      expect(await reverseChild(client, fresh, 1000)).toBe(300)
      const { rows: final } = await raw.query<{ status: string }>(
        `SELECT status FROM payout_transfers WHERE id = $1`,
        [child.id],
      )
      expect(final[0].status).toBe('reversed')
      expect(await remainderOf(s1)).toBe(2000) // whole again
    })

    it('never reverses more than the child is worth', async () => {
      const s1 = await insertSettlement(2000, 2000)
      const payoutId = await insertWriterPayout(1000)
      const sources = await lockFundingSources(client, [s1])
      const { slices } = packUnits([unit('r1', 1000, 0, [s1])], sources, {
        maxSlices: MAX_SLICES,
      })
      await insertChildren(client, 'writer_payouts', payoutId, slices)
      const [child] = await childrenOf('writer_payouts', payoutId)
      await markCompleted(child.id, 'tr_1')
      const fresh = (await childrenOf('writer_payouts', payoutId))[0]

      // A defensively-absent amount_reversed means FULL; an oversized one clamps.
      expect(await reverseChild(client, fresh, 99999)).toBe(1000)
      expect(await reverseChild(client, fresh, null)).toBe(0)
    })
  })

  // ==========================================================================
  // §3.4 — the publication cycle
  // ==========================================================================

  describe('the publication cycle', () => {
    it('routes the already-withheld pooled fee OUT of allocated funds, prorated per split', async () => {
      // The subtlety rev 2 got wrong. The pooled fee was withheld when the pool
      // was computed, so charging an application fee looks like taking it twice.
      // Under allocation the FULL charge is locked, so a fee never claimed as an
      // application_fee_amount never leaves allocated state at ALL — it is taken
      // ZERO times, and roughly a tenth of publication revenue would accumulate
      // as locked funds every cycle.
      const settlement = await insertSettlement(10000, 10000)
      const publicationId = await insertPublication()
      const withheldFee = 800
      const payoutId = await insertPublicationPayout(publicationId, 10000, withheldFee)

      const splits = [
        { id: await insertSplit(payoutId, 6000), amountPence: 6000 },
        { id: await insertSplit(payoutId, 3200), amountPence: 3200 },
      ]
      const distributed = 9200

      const sources = await lockFundingSources(client, [settlement])
      const remaining = new Map(sources.map((s) => [s.settlementId, s.remainingPence]))

      for (const split of splits) {
        const feePence = prorateWithheldFee(withheldFee, split.amountPence, distributed)
        const live = sources.map((s) => ({
          ...s,
          remainingPence: remaining.get(s.settlementId) ?? 0,
        }))
        const { slices } = packUnits(
          [
            {
              id: split.id,
              source: 'publication_payout_splits',
              netPence: split.amountPence,
              feePence,
              preferredSettlementIds: sources.map((s) => s.settlementId),
            },
          ],
          live,
          { maxSlices: MAX_SLICES },
        )
        for (const slice of slices) {
          if (slice.settlementId) {
            remaining.set(
              slice.settlementId,
              (remaining.get(slice.settlementId) ?? 0) - (slice.netPence + slice.feePence),
            )
          }
        }
        await insertChildren(client, 'publication_payout_splits', split.id, slices)
      }

      const c1 = await childrenOf('publication_payout_splits', splits[0].id)
      const c2 = await childrenOf('publication_payout_splits', splits[1].id)
      expect(c1).toHaveLength(1)
      expect(c2).toHaveLength(1)

      // floor(800 × 6000 / 9200) = 521; floor(800 × 3200 / 9200) = 278.
      expect(c1[0].fee_pence).toBe(521)
      expect(c2[0].fee_pence).toBe(278)

      // FLOORED, so the proration UNDER-claims: 799 of 800 leaves, and the
      // remaining penny is real dust for the Balance-Transfer sweep. The two
      // error directions are not symmetric — over-claiming would over-draw the
      // charge and Stripe would reject the transfer outright.
      expect(c1[0].fee_pence + c2[0].fee_pence).toBe(799)
      expect(c1[0].fee_pence + c2[0].fee_pence).toBeLessThanOrEqual(withheldFee)

      // Recipients' nets are untouched — computePublicationSplits is not reopened.
      expect(c1[0].net_pence).toBe(6000)
      expect(c2[0].net_pence).toBe(3200)

      // And the budget fell by net + fee for both, i.e. the fee genuinely left.
      expect(await drawTotal(settlement)).toBe(6000 + 521 + 3200 + 278)
    })

    it('restates a split to what actually paid when one of its children failed', async () => {
      const s1 = await insertSettlement(4000, 4000)
      const s2 = await insertSettlement(4000, 4000)
      const publicationId = await insertPublication()
      const payoutId = await insertPublicationPayout(publicationId, 7000, 0)
      const splitId = await insertSplit(payoutId, 7000)

      // A split large enough to need two charges is packed as one unit and so
      // lands on ONE — the residual fallback documented in packPublicationSplits.
      // Here we force the two-child shape directly to exercise the restatement.
      const sources = await lockFundingSources(client, [s1, s2])
      const { slices } = packUnits(
        [unit('a', 3500, 0, [s1]), unit('b', 3500, 0, [s2])],
        sources,
        { maxSlices: MAX_SLICES },
      )
      await insertChildren(client, 'publication_payout_splits', splitId, slices)
      const children = await childrenOf('publication_payout_splits', splitId)
      expect(children).toHaveLength(2)

      await markCompleted(children[0].id, 'tr_1')
      await failChild(client, children[1].id, 'transfer_rejected')

      const done = await completeParentIfSettled(client, 'publication_payout_splits', splitId)
      expect(done.completed).toBe(true)
      expect(done.paidPence).toBe(3500)

      const { rows } = await raw.query<{ status: string; amount_pence: number }>(
        `SELECT status, amount_pence FROM publication_payout_splits WHERE id = $1`,
        [splitId],
      )
      expect(rows[0].status).toBe('completed')
      // Restated from 7000 to what actually paid. This is what keeps the F5
      // chargeback proration honest: it reverses against what was paid, not
      // what was intended.
      expect(rows[0].amount_pence).toBe(3500)
    })

    it('completes the parent payout on "no split PENDING", never "every split completed"', async () => {
      // The zombie, at the DB level. The old predicate was
      // `NOT EXISTS (split WHERE status <> 'completed')` while the resume sweep
      // retries only 'pending' splits — so one failed split froze the parent
      // forever and no sweep could ever resolve it.
      const publicationId = await insertPublication()
      const payoutId = await insertPublicationPayout(publicationId, 5000, 0)
      const paid = await insertSplit(payoutId, 3000)
      const broken = await insertSplit(payoutId, 2000)

      await raw.query(`UPDATE publication_payout_splits SET status = 'completed' WHERE id = $1`, [paid])
      await raw.query(`UPDATE publication_payout_splits SET status = 'failed' WHERE id = $1`, [broken])

      // The service's OWN statement, imported — not a copy, which could not
      // detect a regression in payout.ts at all.
      expect((await raw.query(PUBLICATION_PAYOUT_COMPLETE_SQL, [payoutId])).rowCount).toBe(1)

      // The paired control: the PRE-FIX predicate on the same rows matches
      // nothing, which is precisely the freeze. Without this the test would
      // merely restate the new rule rather than demonstrate the bug.
      const { rows: zombie } = await raw.query<{ n: string }>(
        `SELECT count(*) AS n FROM publication_payouts pp
          WHERE pp.id = $1
            AND NOT EXISTS (
              SELECT 1 FROM publication_payout_splits s
               WHERE s.publication_payout_id = pp.id
                 AND s.status <> 'completed')`,
        [payoutId],
      )
      expect(parseInt(zombie[0].n, 10)).toBe(0)

      // And a still-PENDING split does hold it open — that arm is unchanged.
      const other = await insertPublicationPayout(publicationId, 5000, 0)
      await insertSplit(other, 3000) // pending
      const { rowCount } = await raw.query(PUBLICATION_PAYOUT_COMPLETE_SQL, [other])
      expect(rowCount).toBe(0)
    })
  })

  // ==========================================================================
  // §3.4 — the tribute cycle
  //
  // The easy one, structurally: each `tribute_accruals` row is a unit with a
  // real preferred settlement (its read's) and zero fee, because the accrual is
  // carved out of the author's ALREADY-post-fee net. What is not easy is the
  // ledger around it — the author's carve is debited per child, from a state
  // the completion transaction is about to change — so that is what these
  // exercise, using the service's own statements.
  //
  // Inert in production while TRIBUTES_ENABLED is off, which is exactly why it
  // is worth pinning now: this is code that will be switched on by someone who
  // was not here.
  // ==========================================================================

  describe('the tribute cycle', () => {
    it('packs an accrual onto the charge its own read was settled on, and restates the parent', async () => {
      const s1 = await insertSettlement(1000, 1000)
      const s2 = await insertSettlement(1000, 1000)
      const { tributeId, inspirerId } = await insertTribute()
      const a1 = await insertAccrual(tributeId, 300, s1)
      const a2 = await insertAccrual(tributeId, 200, s2)
      const payoutId = await insertTributePayout(tributeId, inspirerId, 500)
      await claimAccruals(payoutId, [a1.accrualId, a2.accrualId])

      const sources = await lockFundingSources(client, [s1, s2])
      const { slices } = packUnits(
        [tributeUnit(a1.accrualId, 300, s1), tributeUnit(a2.accrualId, 200, s2)],
        sources,
        { maxSlices: MAX_SLICES },
      )
      const childIds = await insertChildren(client, 'tribute_payouts', payoutId, slices)
      for (let i = 0; i < slices.length; i++) {
        await stampAccruals(childIds[i], slices[i].units.map((u) => u.id))
      }

      // Zero fee, so the draw is the net alone — the accrual has already had the
      // platform's cut taken out of it upstream.
      expect(await drawTotal(s1)).toBe(300)
      expect(await remainderOf(s1)).toBe(700)

      const children = await childrenOf('tribute_payouts', payoutId)
      expect(children).toHaveLength(2)
      for (const c of children) await markCompleted(c.id, `tr_${c.id.slice(0, 8)}`)

      const done = await completeParentIfSettled(client, 'tribute_payouts', payoutId)
      expect(done.completed).toBe(true)
      expect(done.paidPence).toBe(500)

      const { rows } = await raw.query<{ status: string; amount_pence: string }>(
        `SELECT status, amount_pence FROM tribute_payouts WHERE id = $1`,
        [payoutId],
      )
      expect(rows[0].status).toBe('completed')
      expect(parseInt(rows[0].amount_pence, 10)).toBe(500)
    })

    it('reads the author\'s carve BEFORE the advance, which is the whole ordering contract', async () => {
      // The debit is the accruals' GROSS and it is read from `state = 'released'`
      // — so it MUST be taken before `advanceUnits` flips them to 'paid', which
      // is why postLedger runs first inside the shared completion transaction.
      // Read after, it sums 0 and the author silently keeps earnings that left
      // them. Both statements are the service's own, so the order they depend on
      // cannot drift apart from production.
      const settlement = await insertSettlement(1000, 1000)
      const { tributeId, inspirerId } = await insertTribute()
      const a1 = await insertAccrual(tributeId, 300, settlement)
      const payoutId = await insertTributePayout(tributeId, inspirerId, 300)
      await claimAccruals(payoutId, [a1.accrualId])

      const sources = await lockFundingSources(client, [settlement])
      const { slices } = packUnits([tributeUnit(a1.accrualId, 300, settlement)], sources, {
        maxSlices: MAX_SLICES,
      })
      const [childId] = await insertChildren(client, 'tribute_payouts', payoutId, slices)
      await stampAccruals(childId, [a1.accrualId])

      expect(await carveFor(childId)).toBe(300)
      await raw.query(TRIBUTE_CHILD_ADVANCE_SQL, [childId])
      // The paired control — the same statement, one transition later. This is
      // the number production would post if the two hooks were ever reordered.
      expect(await carveFor(childId)).toBe(0)

      const { rows } = await raw.query<{ state: string }>(
        `SELECT state FROM tribute_accruals WHERE id = $1`,
        [a1.accrualId],
      )
      expect(rows[0].state).toBe('paid')
    })

    it('debits the accrual\'s GROSS, not the child\'s post-carve net', async () => {
      // The onward carve to this node's children flows from the INSPIRER, not
      // the author, so the whole accrual left the author here. A child whose net
      // the onward carve reduced still debits the author in full.
      const settlement = await insertSettlement(1000, 1000)
      const { tributeId, inspirerId } = await insertTribute()
      const a1 = await insertAccrual(tributeId, 300, settlement)
      const payoutId = await insertTributePayout(tributeId, inspirerId, 200)
      await claimAccruals(payoutId, [a1.accrualId])

      // net 200 after a 100p onward carve, but the accrual row still reads 300.
      const sources = await lockFundingSources(client, [settlement])
      const { slices } = packUnits([tributeUnit(a1.accrualId, 200, settlement)], sources, {
        maxSlices: MAX_SLICES,
      })
      const [childId] = await insertChildren(client, 'tribute_payouts', payoutId, slices)
      await stampAccruals(childId, [a1.accrualId])

      const children = await childrenOf('tribute_payouts', payoutId)
      expect(children[0].net_pence).toBe(200)
      expect(await carveFor(childId)).toBe(300)
    })

    it('releases exactly the failed child\'s accruals, and VOIDS one whose read was charged back', async () => {
      // Per-child scoping is the point: a sibling that paid must not be disturbed.
      // And a claimed accrual whose read was clawed back mid-flight is terminal —
      // the chargeback planner already reversed it as-if-paid, so releasing it
      // would let the next cycle re-pay money that came back.
      const s1 = await insertSettlement(1000, 1000)
      const s2 = await insertSettlement(1000, 1000)
      const { tributeId, inspirerId } = await insertTribute()
      const good = await insertAccrual(tributeId, 200, s1)
      const clawed = await insertAccrual(tributeId, 100, s1)
      const sibling = await insertAccrual(tributeId, 400, s2)
      const payoutId = await insertTributePayout(tributeId, inspirerId, 700)
      await claimAccruals(payoutId, [good.accrualId, clawed.accrualId, sibling.accrualId])

      const sources = await lockFundingSources(client, [s1, s2])
      const { slices } = packUnits(
        [
          tributeUnit(good.accrualId, 200, s1),
          tributeUnit(clawed.accrualId, 100, s1),
          tributeUnit(sibling.accrualId, 400, s2),
        ],
        sources,
        { maxSlices: MAX_SLICES },
      )
      const childIds = await insertChildren(client, 'tribute_payouts', payoutId, slices)
      for (let i = 0; i < slices.length; i++) {
        await stampAccruals(childIds[i], slices[i].units.map((u) => u.id))
      }
      const doomed = childIds[slices.findIndex((s) => s.settlementId === s1)]
      const survivor = childIds[slices.findIndex((s) => s.settlementId === s2)]

      // The clawed-back read flips terminal while the transfer is in flight.
      await raw.query(
        `UPDATE read_events SET state = 'charged_back' WHERE id = $1`,
        [clawed.readId],
      )

      expect(await failChild(client, doomed, 'transfer_rejected')).toBe(true)
      const { rows: voided } = await raw.query(TRIBUTE_CHILD_VOID_SQL, [doomed])
      await raw.query(TRIBUTE_CHILD_RELEASE_SQL, [doomed])

      expect(voided.map((r) => parseInt(r.amount_pence, 10))).toEqual([100])
      expect(await accrualState(clawed.accrualId)).toEqual({
        state: 'voided',
        claimed: false,
        child: null,
      })
      expect(await accrualState(good.accrualId)).toEqual({
        state: 'released',
        claimed: false, // unclaimed ⇒ the next cycle re-pays it
        child: null,
      })
      // The sibling on the other charge is untouched — still claimed, still
      // stamped, its transfer unaffected by its neighbour's rejection.
      expect(await accrualState(sibling.accrualId)).toEqual({
        state: 'released',
        claimed: true,
        child: survivor,
      })
      // And the failed child's allocation is back in the budget.
      expect(await remainderOf(s1)).toBe(1000)
    })

    it('advances the carve-zeroed accruals at parent completion, exactly once', async () => {
      // An accrual the onward carve consumed entirely gets no child (Stripe
      // rejects amount: 0) but keeps its parent claim. Leaving it 'released'
      // would let the next cycle claim and pay it a second time.
      //
      // The RETURNING is the single-shot gate the root carve entry hangs on:
      // `completeParentIfSettled` reports `completed` from a tally rather than
      // from its own UPDATE's rowCount, so it cannot supply one, and a ledger
      // post is not idempotent the way a state-filtered UPDATE is.
      const settlement = await insertSettlement(1000, 1000)
      const { tributeId, inspirerId } = await insertTribute()
      const paidUnit = await insertAccrual(tributeId, 400, settlement)
      const consumed = await insertAccrual(tributeId, 150, settlement)
      const payoutId = await insertTributePayout(tributeId, inspirerId, 400)
      await claimAccruals(payoutId, [paidUnit.accrualId, consumed.accrualId])

      const sources = await lockFundingSources(client, [settlement])
      const { slices } = packUnits([tributeUnit(paidUnit.accrualId, 400, settlement)], sources, {
        maxSlices: MAX_SLICES,
      })
      const [childId] = await insertChildren(client, 'tribute_payouts', payoutId, slices)
      await stampAccruals(childId, [paidUnit.accrualId])
      await markCompleted(childId, 'tr_zeroed')

      const first = await raw.query<{ amount_pence: string }>(
        TRIBUTE_CHILDLESS_ADVANCE_SQL,
        [payoutId],
      )
      expect(first.rows.map((r) => parseInt(r.amount_pence, 10))).toEqual([150])
      expect(await accrualState(consumed.accrualId)).toMatchObject({ state: 'paid' })

      // Re-running finalisation — a resume sweep, a stray transfer.paid — must
      // add nothing. A carve posted off `first` would double on `second`.
      const second = await raw.query(TRIBUTE_CHILDLESS_ADVANCE_SQL, [payoutId])
      expect(second.rows).toHaveLength(0)

      // The stamped one is NOT swept up by this statement: it is the child's to
      // advance, and it already was.
      expect(await accrualState(paidUnit.accrualId)).toMatchObject({ child: childId })
    })

    it('fails a tribute parent OUTRIGHT when every child failed, rather than leaving a zombie', async () => {
      // The tribute branch of completeParentIfSettled has its own SQL, so it
      // needs its own proof: a parent left 'pending' with no pending child is
      // revisited by the resume sweep every cycle and never resolved.
      const settlement = await insertSettlement(1000, 1000)
      const { tributeId, inspirerId } = await insertTribute()
      const a1 = await insertAccrual(tributeId, 300, settlement)
      const payoutId = await insertTributePayout(tributeId, inspirerId, 300)
      await claimAccruals(payoutId, [a1.accrualId])

      const sources = await lockFundingSources(client, [settlement])
      const { slices } = packUnits([tributeUnit(a1.accrualId, 300, settlement)], sources, {
        maxSlices: MAX_SLICES,
      })
      const [childId] = await insertChildren(client, 'tribute_payouts', payoutId, slices)
      await failChild(client, childId, 'transfer_rejected')

      const outcome = await completeParentIfSettled(client, 'tribute_payouts', payoutId)
      expect(outcome.completed).toBe(false)
      expect(outcome.failedOutright).toBe(true)

      const { rows } = await raw.query<{ status: string; failed_reason: string | null }>(
        `SELECT status, failed_reason FROM tribute_payouts WHERE id = $1`,
        [payoutId],
      )
      expect(rows[0].status).toBe('failed')
      expect(rows[0].failed_reason).toContain('failed')
    })

    it('reverses one child\'s carve in proportion to THAT child, leaving its sibling alone', async () => {
      // The parent-grain guard sums `tribute_payout_reversal` entries against the
      // payout row; N children share that ref, so it cannot tell them apart. The
      // child's own `reversed_pence` can, and the carve re-credit is prorated
      // against it — over the carve of the CHILD's accruals, not the payout's.
      const s1 = await insertSettlement(1000, 1000)
      const s2 = await insertSettlement(1000, 1000)
      const { tributeId, inspirerId } = await insertTribute()
      const a1 = await insertAccrual(tributeId, 400, s1)
      const a2 = await insertAccrual(tributeId, 200, s2)
      const payoutId = await insertTributePayout(tributeId, inspirerId, 600)
      await claimAccruals(payoutId, [a1.accrualId, a2.accrualId])

      const sources = await lockFundingSources(client, [s1, s2])
      const { slices } = packUnits(
        [tributeUnit(a1.accrualId, 400, s1), tributeUnit(a2.accrualId, 200, s2)],
        sources,
        { maxSlices: MAX_SLICES },
      )
      const childIds = await insertChildren(client, 'tribute_payouts', payoutId, slices)
      for (let i = 0; i < slices.length; i++) {
        await stampAccruals(childIds[i], slices[i].units.map((u) => u.id))
      }
      const first = childIds[slices.findIndex((s) => s.settlementId === s1)]
      const second = childIds[slices.findIndex((s) => s.settlementId === s2)]
      for (const id of childIds) {
        await markCompleted(id, `tr_${id.slice(0, 8)}`)
        await raw.query(TRIBUTE_CHILD_ADVANCE_SQL, [id])
      }

      const child = (await childrenOf('tribute_payouts', payoutId)).find((c) => c.id === first)!
      // Half of the 400p child comes back, staged.
      expect(await reverseChild(client, child, 200)).toBe(200)
      expect(prorateCarveReversal(await paidCarveFor(first), 400, 0, 200)).toBe(200)
      // A redelivery of the same cumulative figure adds nothing.
      expect(await reverseChild(client, child, 200)).toBe(0)

      // The sibling is untouched — the whole reason for re-keying off the child.
      const { rows: sib } = await raw.query<{ reversed_pence: number; status: string }>(
        `SELECT reversed_pence, status FROM payout_transfers WHERE id = $1`,
        [second],
      )
      expect(sib[0].reversed_pence).toBe(0)
      expect(sib[0].status).toBe('completed')

      // Reversed funds return to the ALLOCATED state, not platform balance, so
      // the charge's remainder grows back by exactly what came home.
      expect(await remainderOf(s1)).toBe(1000 - 400 + 200)
    })
  })

  // ==========================================================================
  // §3.6 + §3.3d — reconciliation, the only visibility segregation has
  //
  // Both of these are SQL predicates, which is precisely the class a mocked
  // `pool.query` cannot evaluate: a `FILTER`, an interval window, a correlated
  // subquery. A mock would answer from a fixture whose shape the test chose and
  // stay green against arithmetic that had silently changed.
  // ==========================================================================

  describe('reconciliation', () => {
    it('reports what our model believes is left on each charge, net of every draw', async () => {
      const settlement = await insertSettlement(5000, 5000)
      const payoutId = await insertWriterPayout(900)

      const sources = await lockFundingSources(client, [settlement])
      const { slices } = packUnits([unit('u1', 900, 100, [settlement])], sources, {
        maxSlices: MAX_SLICES,
      })
      await insertChildren(client, 'writer_payouts', payoutId, slices)
      await recordRefundDraw(settlement, 500)

      const row = await divergenceCandidate(settlement)
      // 5000 allocated − (900 + 100 transfer) − 500 refund.
      expect(parseInt(row!.our_remaining, 10)).toBe(3500)
    })

    it('reports a NEGATIVE remainder rather than flooring it, because that is the alert', async () => {
      // `lockFundingSources` floors its budget at 0 — an under-draw is safe
      // there. Here the raw figure is the whole point: a model that has drawn
      // past zero is exactly the state worth waking someone for, and flooring
      // would hide the magnitude behind an ordinary-looking 0.
      const settlement = await insertSettlement(1000, 1000)
      await recordRefundDraw(settlement, 4000)

      expect(await remainderOf(settlement)).toBe(0) // the packer's view
      expect(parseInt((await divergenceCandidate(settlement))!.our_remaining, 10)).toBe(-3000)
    })

    it('never offers a charge it has not read back from Stripe', async () => {
      // NULL allocated_pence means "not known to be drawable". Such a charge has
      // no model figure to diverge FROM, so comparing it would manufacture a
      // divergence out of our own ignorance — and silently, since the arithmetic
      // would yield NULL and NULL is never divergent.
      const unsynced = await insertSettlement(5000, null)
      expect(await divergenceCandidate(unsynced)).toBeUndefined()

      // `syncAllocations` writes `allocated_pence` and `allocation_synced_at`
      // together, so in production the two guards are redundant and a test that
      // seeded only the ordinary case would pass with EITHER of them deleted —
      // which is no test of either. Pose the combination the pair exists for:
      // stamped as synced, with no figure. Only the allocated_pence guard
      // excludes this row.
      await raw.query(
        `UPDATE tab_settlements SET allocation_synced_at = now() WHERE id = $1`,
        [unsynced],
      )
      expect(await divergenceCandidate(unsynced)).toBeUndefined()
    })

    it('counts the residual share over completed and REVERSED children, never failed ones', async () => {
      // Reversed: the transfer happened and was funded from somewhere, and the
      // reversal is a separate fact. Failed: nothing moved, so counting it would
      // report coverage for money that never left.
      // Baseline first: RESIDUAL_SHARE_SQL is a GLOBAL 30-day aggregate, and the
      // rolled-back transaction isolates our WRITES, not our READS — every
      // committed child anyone else has ever created is still in the window. So
      // assert the DELTA this test contributes, never the absolute total, which
      // is only 1000 on a database where no payout has ever run.
      const base = await residualWindow()

      const settlement = await insertSettlement(10000, 10000)
      const payoutId = await insertWriterPayout(1000)
      const allocated = await seedChild(payoutId, 'allocated', 600, settlement)
      const residual = await seedChild(payoutId, 'platform_balance', 200, null)
      const reversedResidual = await seedChild(payoutId, 'platform_balance', 200, null)
      const failedResidual = await seedChild(payoutId, 'platform_balance', 9000, null)

      await setChildStatus(allocated, 'completed', '1 day')
      await setChildStatus(residual, 'completed', '1 day')
      await setChildStatus(reversedResidual, 'reversed', '1 day')
      await setChildStatus(failedResidual, 'failed', '1 day')

      const after = await residualWindow()
      const total = after.total - base.total
      const residualPence = after.residual - base.residual

      expect(total).toBe(1000) // 600 + 200 + 200 — the failed 9000 is absent
      expect(residualPence).toBe(400)
      // summariseResidual is pure, so feed it the deltas: the ratio this test
      // poses is the property under test, not whatever the host DB's history is.
      expect(summariseResidual(total, residualPence, 2000)).toMatchObject({
        residualBps: 4000,
        breached: true,
      })
    })

    it('is a ROLLING window — a child older than 30 days no longer counts', async () => {
      // The dial is a rolling-30-day share, so a historical spike must age out
      // rather than keeping the alert lit forever.
      // Delta, not absolute — see the sibling test above for why.
      const base = await residualWindow()

      const settlement = await insertSettlement(10000, 10000)
      const payoutId = await insertWriterPayout(1000)
      const recent = await seedChild(payoutId, 'allocated', 500, settlement)
      const old = await seedChild(payoutId, 'platform_balance', 500, null)

      await setChildStatus(recent, 'completed', '2 days')
      await setChildStatus(old, 'completed', '31 days')

      const after = await residualWindow()
      expect(after.total - base.total).toBe(500)
      expect(after.residual - base.residual).toBe(0)
    })
  })

  // --- reconciliation fixtures ------------------------------------------------

  async function divergenceCandidate(
    settlementId: string,
  ): Promise<DivergenceCandidate | undefined> {
    // The service's OWN statement, imported — the remaining-budget arithmetic
    // and the NOT NULL guard are properties of this SQL.
    const { rows } = await raw.query<DivergenceCandidate>(
      ALLOCATION_DIVERGENCE_CANDIDATES_SQL,
      [500],
    )
    return rows.find((r) => r.id === settlementId)
  }

  async function residualWindow(): Promise<{ total: number; residual: number }> {
    const { rows } = await raw.query<{ total: string; residual: string }>(
      RESIDUAL_SHARE_SQL,
      [30],
    )
    return {
      total: parseInt(rows[0].total, 10),
      residual: parseInt(rows[0].residual, 10),
    }
  }

  /**
   * A child written directly, so its funding and status can be posed.
   *
   * The rolled-back transaction isolates these WRITES from other sessions — it
   * does NOT narrow what the window queries READ. `RESIDUAL_SHARE_SQL` is a
   * global 30-day aggregate and sees every committed child in the database, so
   * its callers must compare a DELTA against a baseline taken before seeding.
   * (The original comment here claimed the opposite; the assertions were absolute
   * and went red the first time a real payout ran in a dev database, 2026-07-31.)
   */
  async function seedChild(
    parentId: string,
    funding: 'allocated' | 'platform_balance',
    netPence: number,
    settlementId: string | null,
  ): Promise<string> {
    const { rows: charge } = settlementId
      ? await raw.query<{ stripe_charge_id: string }>(
          `SELECT stripe_charge_id FROM tab_settlements WHERE id = $1`,
          [settlementId],
        )
      : { rows: [{ stripe_charge_id: null as string | null }] }
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO payout_transfers
         (parent_table, parent_id, settlement_id, stripe_charge_id, funding, net_pence, status)
       VALUES ('writer_payouts', $1, $2, $3, $4, $5, 'pending') RETURNING id`,
      [parentId, settlementId, charge[0].stripe_charge_id, funding, netPence],
    )
    return rows[0].id
  }

  async function setChildStatus(childId: string, status: string, ago: string) {
    await raw.query(
      `UPDATE payout_transfers
          SET status = $2, completed_at = now() - $3::interval
        WHERE id = $1`,
      [childId, status, ago],
    )
  }

  // --- tribute fixtures -------------------------------------------------------

  const tributeUnit = (id: string, netPence: number, settlementId: string): EarningUnit => ({
    id,
    source: 'tribute_accruals',
    netPence,
    // Zero, always: a tribute accrual is carved out of the author's already
    // post-fee net, so there is no second fee to claim as an application fee.
    feePence: 0,
    preferredSettlementIds: [settlementId],
  })

  async function insertArticle(): Promise<string> {
    const s = uniq()
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, published_at)
       VALUES ($1, $2, $2, $3, $2, now()) RETURNING id`,
      [writerId, s, `Article ${s}`],
    )
    return rows[0].id
  }

  /** A live ROOT tribute on a fresh article, with an onboarded inspirer. */
  async function insertTribute(): Promise<{
    tributeId: string
    inspirerId: string
    articleId: string
  }> {
    const inspirerId = await insertAccount()
    const articleId = await insertArticle()
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO tributes
         (article_id, author_account_id, percentage_bps, resolved_account_id, status, consent_at)
       VALUES ($1, $2, 1000, $3, 'live', now()) RETURNING id`,
      [articleId, writerId, inspirerId],
    )
    return { tributeId: rows[0].id, inspirerId, articleId }
  }

  /** A settled read plus the released accrual it produced. */
  async function insertAccrual(
    tributeId: string,
    amountPence: number,
    settlementId: string,
  ): Promise<{ accrualId: string; readId: string }> {
    const { rows: article } = await raw.query<{ article_id: string }>(
      `SELECT article_id FROM tributes WHERE id = $1`,
      [tributeId],
    )
    const { rows: read } = await raw.query<{ id: string }>(
      `INSERT INTO read_events
         (reader_id, article_id, writer_id, tab_id, amount_pence, state, tab_settlement_id)
       VALUES ($1, $2, $3, $4, $5, 'platform_settled', $6) RETURNING id`,
      [readerId, article[0].article_id, writerId, tabId, amountPence * 10, settlementId],
    )
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO tribute_accruals (tribute_id, read_event_id, amount_pence, state)
       VALUES ($1, $2, $3, 'released') RETURNING id`,
      [tributeId, read[0].id, amountPence],
    )
    return { accrualId: rows[0].id, readId: read[0].id }
  }

  async function insertTributePayout(
    tributeId: string,
    inspirerId: string,
    amountPence: number,
  ): Promise<string> {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO tribute_payouts
         (tribute_id, inspirer_account_id, author_account_id, amount_pence, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [tributeId, inspirerId, writerId, amountPence],
    )
    return rows[0].id
  }

  async function claimAccruals(payoutId: string, accrualIds: string[]) {
    await raw.query(
      `UPDATE tribute_accruals SET tribute_payout_id = $1 WHERE id = ANY($2)`,
      [payoutId, accrualIds],
    )
  }

  async function stampAccruals(childId: string, accrualIds: string[]) {
    await raw.query(
      `UPDATE tribute_accruals SET payout_transfer_id = $1 WHERE id = ANY($2)`,
      [childId, accrualIds],
    )
  }

  /** The service's own carve statement — the pre-advance figure. */
  async function carveFor(childId: string): Promise<number> {
    const { rows } = await raw.query<{ carve_pence: string }>(TRIBUTE_CHILD_CARVE_SQL, [childId])
    return parseInt(rows[0].carve_pence, 10)
  }

  /** The reversal-side carve: 'paid', so a voided accrual is already excluded. */
  async function paidCarveFor(childId: string): Promise<number> {
    const { rows } = await raw.query<{ carve_pence: string }>(
      `SELECT COALESCE(SUM(amount_pence), 0) AS carve_pence
         FROM tribute_accruals
        WHERE payout_transfer_id = $1 AND state = 'paid'`,
      [childId],
    )
    return parseInt(rows[0].carve_pence, 10)
  }

  async function accrualState(accrualId: string): Promise<{
    state: string
    claimed: boolean
    child: string | null
  }> {
    const { rows } = await raw.query<{
      state: string
      tribute_payout_id: string | null
      payout_transfer_id: string | null
    }>(
      `SELECT state, tribute_payout_id, payout_transfer_id
         FROM tribute_accruals WHERE id = $1`,
      [accrualId],
    )
    return {
      state: rows[0].state,
      claimed: rows[0].tribute_payout_id !== null,
      child: rows[0].payout_transfer_id,
    }
  }
})
