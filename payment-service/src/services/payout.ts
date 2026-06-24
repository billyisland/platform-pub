import Stripe from 'stripe'
import type { WriterEarnings, ArticleEarnings } from '../types/index.js'
import { pool, withTransaction, loadConfig } from '@platform-pub/shared/db/client.js'
import { recordLedger } from '@platform-pub/shared/lib/ledger.js'
import { tributesEnabled } from '@platform-pub/shared/lib/env.js'
import { readNetSql } from '@platform-pub/shared/lib/per-read-net.js'
import logger from '../lib/logger.js'

// =============================================================================
// PayoutService — Stage 3 of the three-stage money flow
//
// Runs on a daily rolling basis. For each writer whose available balance
// (platform_settled reads not yet paid out) exceeds £20.00:
//   1. Lock writer record
//   2. Compute amount = sum of platform_settled read_events not yet in a payout
//   3. Create Stripe Connect transfer from platform account to writer
//   4. Write writer_payout record
//   5. Link read_events to payout
//
// Writer must have completed Stripe Connect KYC before payouts can be made.
// Earnings accrue and are held until verification completes.
// =============================================================================

// =============================================================================
// Publication split computation — extracted as a pure function for testability
// =============================================================================

export interface ArticleShare {
  id: string
  articleId: string
  accountId: string
  shareType: 'flat_fee_pence' | 'revenue_bps'
  shareValue: number
  paidOut: boolean
}

export interface StandingMember {
  accountId: string
  revenueShareBps: number
}

interface Split {
  accountId: string
  amountPence: number
  shareType: string
  shareBps: number | null
  articleId: string | null
}

interface SplitResult {
  platformFeePence: number
  splits: Split[]
  remainingPool: number
  flatFeesPaidPence: number
  flatFeeShareIds: string[]
}

export function computePublicationSplits(
  grossPence: number,
  feeBps: number,
  articleShares: ArticleShare[],
  articleEarnings: Map<string, number>,
  standingMembers: StandingMember[],
): SplitResult {
  const platformFeePence = Math.floor(grossPence * feeBps / 10000)
  let remainingPool = grossPence - platformFeePence
  let flatFeesPaidPence = 0
  const splits: Split[] = []
  const flatFeeShareIds: string[] = []

  // Step 1: Per-article overrides
  for (const share of articleShares) {
    if (share.shareType === 'flat_fee_pence' && !share.paidOut) {
      const fee = share.shareValue
      if (fee > remainingPool) continue
      remainingPool -= fee
      flatFeesPaidPence += fee
      flatFeeShareIds.push(share.id)
      splits.push({
        accountId: share.accountId, amountPence: fee,
        shareType: 'flat_fee', shareBps: null,
        articleId: share.articleId,
      })
    } else if (share.shareType === 'revenue_bps') {
      const articleNet = articleEarnings.get(share.articleId) || 0
      const payout = Math.floor(articleNet * share.shareValue / 10000)
      if (payout <= 0) continue
      remainingPool -= payout
      splits.push({
        accountId: share.accountId, amountPence: payout,
        shareType: 'article_revenue', shareBps: share.shareValue,
        articleId: share.articleId,
      })
    }
  }

  // Step 2: Standing shares
  const totalStandingBps = standingMembers.reduce((sum, m) => sum + m.revenueShareBps, 0)

  if (totalStandingBps > 0 && remainingPool > 0) {
    for (const member of standingMembers) {
      const payout = Math.floor(remainingPool * member.revenueShareBps / totalStandingBps)
      if (payout <= 0) continue
      splits.push({
        accountId: member.accountId, amountPence: payout,
        shareType: 'standing', shareBps: member.revenueShareBps,
        articleId: null,
      })
    }
  }

  return { platformFeePence, splits, remainingPool, flatFeesPaidPence, flatFeeShareIds }
}

class PayoutService {
  private stripe: Stripe

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
    })
  }

  // ---------------------------------------------------------------------------
  // getWriterEarnings — for the dashboard endpoint
  //
  // FIX #4: The ADR (§I.3) states: "Writers' dashboards show post-cut
  // earnings throughout." Previously this query summed gross amount_pence
  // from read_events, which is what the reader paid — not what the writer
  // earns. Now we join to tab_settlements to compute the writer's net share.
  //
  // For writer_paid reads, the payout amount already reflects the net
  // (Stripe transfers are net-of-fee). For platform_settled reads, we
  // compute net from the settlement's fee ratio.
  // ---------------------------------------------------------------------------

  async getWriterEarnings(writerId: string): Promise<WriterEarnings> {
    const config = await loadConfig()

    const { rows } = await pool.query<{
      earnings_total_pence: string
      pending_transfer_pence: string
      paid_out_pence: string
      reserved_pence: string
      read_count: string
    }>(
      // Tribute carve (Upstream Edges Phase 3 + Phase-5 chains): a tributed read's
      // writer-side net is reduced by the share carved off by this author's DIRECT
      // children — the ROOT tributes (parent_tribute_id IS NULL). Subtracting only
      // roots leaves the author with read_net − Σ root_gross = the author's
      // retained net; the deeper chain shares are *within* a root's gross, carved
      // by the inspirer nodes, not the author (telescoping). Display subtracts the
      // LIVE root accruals (held|released|paid) — redirected to the root inspirer
      // (or reserved pending consent); swept/returned roots stay the author's, so
      // they are NOT subtracted. The LEFT JOIN is a no-op when no accruals exist.
      `SELECT
         COALESCE(SUM(
           CASE
             WHEN r.state IN ('platform_settled', 'writer_paid')
               THEN ${readNetSql('r.amount_pence', '$2')} - COALESCE(acc.live_pence, 0)
             ELSE 0
           END
         ), 0) AS earnings_total_pence,
         COALESCE(SUM(
           CASE WHEN r.state = 'platform_settled'
             THEN ${readNetSql('r.amount_pence', '$2')} - COALESCE(acc.live_pence, 0)
             ELSE 0
           END
         ), 0) AS pending_transfer_pence,
         COALESCE(SUM(
           CASE WHEN r.state = 'writer_paid'
             THEN ${readNetSql('r.amount_pence', '$2')} - COALESCE(acc.live_pence, 0)
             ELSE 0
           END
         ), 0) AS paid_out_pence,
         COUNT(*) AS read_count
       FROM read_events r
       LEFT JOIN (
         -- ROOT accruals only (the author's direct children).
         SELECT ta.read_event_id, SUM(ta.amount_pence) AS live_pence
         FROM tribute_accruals ta
         JOIN tributes t ON t.id = ta.tribute_id
         WHERE ta.state IN ('held', 'released', 'paid')
           AND t.parent_tribute_id IS NULL
         GROUP BY ta.read_event_id
       ) acc ON acc.read_event_id = r.id
       WHERE r.writer_id = $1
         AND r.state IN ('platform_settled', 'writer_paid')`,
      [writerId, config.platformFeeBps]
    )

    const row = rows[0]

    // Reserved, pending redirect (compliance condition #4) — uniform across the
    // tree: Σ(held|released) accruals of every tribute this account is the
    // PARTY-OF-FUNDS for (tribute.author_account_id = X). That is the article
    // author for ROOT tributes and an inspirer node for its CHILDREN — so this
    // single query captures both "reserved from my article earnings" (roots) and
    // "reserved from a tribute share I received, pending onward redirect"
    // (children). 'paid' is gone to the payee; 'swept'/'returned' come back, so
    // neither counts. No-op (0) when dark.
    const { rows: resRows } = await pool.query<{ reserved_pence: string }>(
      `SELECT COALESCE(SUM(ta.amount_pence), 0) AS reserved_pence
         FROM tribute_accruals ta
         JOIN tributes t ON t.id = ta.tribute_id
        WHERE t.author_account_id = $1
          AND ta.state IN ('held', 'released')`,
      [writerId]
    )

    return {
      writerId,
      earningsTotalPence: parseInt(row.earnings_total_pence, 10),
      pendingTransferPence: parseInt(row.pending_transfer_pence, 10),
      paidOutPence: parseInt(row.paid_out_pence, 10),
      reservedPence: parseInt(resRows[0].reserved_pence, 10),
      readCount: parseInt(row.read_count, 10),
    }
  }

  // ---------------------------------------------------------------------------
  // getPerArticleEarnings — per-article breakdown for the dashboard
  //
  // Per ADR §I.2: "The dashboard must show settled per-article revenue, with
  // a clear breakdown of platform-settled and writer-paid amounts."
  //
  // Returns articles sorted by total net earnings descending.
  // Only includes articles with at least one platform_settled or writer_paid read.
  // ---------------------------------------------------------------------------

  async getPerArticleEarnings(writerId: string): Promise<ArticleEarnings[]> {
    const config = await loadConfig()

    const { rows } = await pool.query<{
      article_id: string
      title: string
      nostr_d_tag: string
      published_at: string | null
      read_count: string
      net_earnings_pence: string
      pending_pence: string
      paid_pence: string
    }>(
      `SELECT
         a.id AS article_id,
         a.title,
         a.nostr_d_tag,
         a.published_at,
         COUNT(r.id) AS read_count,
         COALESCE(SUM(${readNetSql('r.amount_pence', '$2')} - COALESCE(acc.live_pence, 0)), 0) AS net_earnings_pence,
         COALESCE(SUM(CASE WHEN r.state = 'platform_settled'
           THEN ${readNetSql('r.amount_pence', '$2')} - COALESCE(acc.live_pence, 0) ELSE 0 END), 0) AS pending_pence,
         COALESCE(SUM(CASE WHEN r.state = 'writer_paid'
           THEN ${readNetSql('r.amount_pence', '$2')} - COALESCE(acc.live_pence, 0) ELSE 0 END), 0) AS paid_pence
       FROM read_events r
       JOIN articles a ON a.id = r.article_id
       LEFT JOIN (
         -- ROOT accruals only (the author carves its direct children; deeper
         -- chain shares live within a root's gross — Phase-5 telescoping).
         SELECT ta.read_event_id, SUM(ta.amount_pence) AS live_pence
         FROM tribute_accruals ta
         JOIN tributes t ON t.id = ta.tribute_id
         WHERE ta.state IN ('held', 'released', 'paid')
           AND t.parent_tribute_id IS NULL
         GROUP BY ta.read_event_id
       ) acc ON acc.read_event_id = r.id
       WHERE r.writer_id = $1
         AND r.state IN ('platform_settled', 'writer_paid')
       GROUP BY a.id, a.title, a.nostr_d_tag, a.published_at
       ORDER BY net_earnings_pence DESC`,
      [writerId, config.platformFeeBps]
    )

    return rows.map(r => ({
      articleId: r.article_id,
      title: r.title,
      dTag: r.nostr_d_tag,
      publishedAt: r.published_at,
      readCount: parseInt(r.read_count, 10),
      netEarningsPence: parseInt(r.net_earnings_pence, 10),
      pendingPence: parseInt(r.pending_pence, 10),
      paidPence: parseInt(r.paid_pence, 10),
    }))
  }

  // ---------------------------------------------------------------------------
  // runPayoutCycle — called by the daily payout worker
  // Processes all eligible writers in one pass
  //
  // Note: The payout amount is net-of-fee. The platform fee was already
  // deducted at settlement (Stage 2). Stripe transfers move only the
  // writer's share.
  // ---------------------------------------------------------------------------

  async runPayoutCycle(): Promise<{ processed: number; totalPaidPence: number }> {
    // Resume any pending payouts from previous runs first. A pending row means
    // we committed the reservation but crashed before Stripe returned or before
    // the 'initiated' update landed. Stable idempotency keys make the Stripe
    // call safe to retry — if the transfer was already created on a prior
    // attempt, Stripe returns the same response rather than creating a second.
    await this.resumePendingWriterPayouts()

    const config = await loadConfig()

    // Find writers with enough platform_settled balance and completed KYC.
    // Combines read_events earnings with upvote earnings (vote_charges with recipient_id set).
    // FIX #4: Compute net amounts (after platform fee) for payout eligibility.
    //
    // Rounding: the platform fee is applied per-row then summed, not applied
    // once to the grand total. This matches the "platform absorbs rounding
    // dust" rule the settlement and split paths already follow
    // (tests/payout-math.test.ts:183, tests/settlement.test.ts:135). A 1p
    // read at 8% bps floors the fee to 0, so the writer keeps the full
    // penny; summing-then-flooring would instead collapse N of those pennies
    // into a single non-zero fee. The per-row form is very slightly
    // writer-favourable (up to N-1 pence across N rows) and intentional.
    // Tribute carve/return (Upstream Edges Phase 3 + Phase-5 chains) fold into the
    // writer's net:
    //   net = Σ per-read net (reads + upvotes)
    //         − Σ ROOT accruals on the reads being paid this cycle  (carve)
    //         + Σ swept ROOT accruals owed back to this author       (return)
    // The author is the depth-0 carving party: it carves its DIRECT children —
    // the ROOT tributes (parent_tribute_id IS NULL), state-agnostic (each root's
    // disposition is the second leg: released→paid to the root inspirer /
    // swept→returned here). Deeper chain shares are carved by the inspirer nodes
    // (runTributePayoutCycle), not the author. The swept ROOT shares returned to
    // this author are claimed exactly once via swept_return_payout_id (kind
    // 'writer'). CTEs are no-ops when dark. `candidates` is base ∪ ret so a writer
    // whose only balance is a swept return (no fresh reads) is eligible.
    const { rows: eligibleWriters } = await pool.query<{
      writer_id: string
      gross_pence: string
      net_pence: string
      stripe_connect_id: string
    }>(
      `WITH base AS (
         SELECT earnings.writer_id,
                SUM(earnings.amount_pence) AS gross_pence,
                SUM(${readNetSql('earnings.amount_pence', '$2')}) AS net_pence
         FROM (
           SELECT writer_id, amount_pence
           FROM read_events
           WHERE state = 'platform_settled' AND writer_payout_id IS NULL
           UNION ALL
           SELECT recipient_id AS writer_id, amount_pence
           FROM vote_charges
           WHERE state = 'platform_settled'
             AND recipient_id IS NOT NULL
             AND writer_payout_id IS NULL
         ) AS earnings
         GROUP BY earnings.writer_id
       ),
       carve AS (
         SELECT re.writer_id, SUM(ta.amount_pence) AS carve_pence
         FROM tribute_accruals ta
         JOIN read_events re ON re.id = ta.read_event_id
         JOIN tributes t ON t.id = ta.tribute_id
         WHERE re.state = 'platform_settled' AND re.writer_payout_id IS NULL
           AND t.parent_tribute_id IS NULL
         GROUP BY re.writer_id
       ),
       ret AS (
         SELECT t.author_account_id AS writer_id, SUM(ta.amount_pence) AS return_pence
         FROM tribute_accruals ta
         JOIN tributes t ON t.id = ta.tribute_id
         WHERE ta.state = 'swept' AND ta.swept_return_payout_id IS NULL
           AND t.parent_tribute_id IS NULL
         GROUP BY t.author_account_id
       ),
       candidates AS (
         SELECT writer_id FROM base
         UNION
         SELECT writer_id FROM ret
       )
       SELECT c.writer_id,
              COALESCE(base.gross_pence, 0) AS gross_pence,
              (COALESCE(base.net_pence, 0) - COALESCE(carve.carve_pence, 0)
                 + COALESCE(ret.return_pence, 0)) AS net_pence,
              a.stripe_connect_id
       FROM candidates c
       JOIN accounts a ON a.id = c.writer_id
       LEFT JOIN base  ON base.writer_id  = c.writer_id
       LEFT JOIN carve ON carve.writer_id = c.writer_id
       LEFT JOIN ret   ON ret.writer_id   = c.writer_id
       WHERE a.stripe_connect_kyc_complete = TRUE
         AND a.stripe_connect_id IS NOT NULL
         AND (COALESCE(base.net_pence, 0) - COALESCE(carve.carve_pence, 0)
                + COALESCE(ret.return_pence, 0)) >= $1`,
      [config.writerPayoutThresholdPence, config.platformFeeBps]
    )

    let processed = 0
    let totalPaidPence = 0

    for (const writer of eligibleWriters) {
      try {
        const netPence = parseInt(writer.net_pence, 10)
        const payoutId = await this.initiateWriterPayout(
          writer.writer_id,
          writer.stripe_connect_id,
          netPence,
        )
        if (payoutId) {
          processed++
          totalPaidPence += netPence
        }
      } catch (err) {
        logger.error({ err, writerId: writer.writer_id }, 'Payout failed for writer — continuing cycle')
      }
    }

    logger.info({ processed, totalPaidPence }, 'Payout cycle complete')
    return { processed, totalPaidPence }
  }

  // ---------------------------------------------------------------------------
  // initiateWriterPayout — single writer payout
  //
  // FIX-PROGRAMME §3: Split into two committed phases with a Stripe call in
  // between. Earlier, the entire flow ran inside one transaction with the
  // Stripe transfer created before any DB write — any later throw rolled the
  // transaction back while the transfer stayed live, orphaning writer money
  // from the ledger. Now:
  //
  //   1. reserveWriterPayout (Txn 1, committed) — insert 'pending' row and
  //      stamp read_events / vote_charges with writer_payout_id so no
  //      concurrent cycle can re-count them.
  //   2. stripe.transfers.create with idempotencyKey=`payout-${payoutId}`
  //      (stable — same key on any retry deduplicates against the prior
  //      transfer).
  //   3. completeWriterPayout (Txn 2, committed) — flip status to 'initiated',
  //      store stripe_transfer_id, advance reads/vote_charges to writer_paid.
  //
  // If we crash or throw between steps 1 and 3, the 'pending' row survives
  // and resumePendingWriterPayouts (called at cycle start) re-runs steps
  // 2–3 with the same stable key.
  // ---------------------------------------------------------------------------

  private async initiateWriterPayout(
    writerId: string,
    stripeConnectId: string,
    amountPence: number,
  ): Promise<string | null> {
    const reserved = await this.reserveWriterPayout(writerId, stripeConnectId, amountPence)
    if (!reserved) return null

    await this.completeWriterPayout(
      reserved.payoutId,
      writerId,
      stripeConnectId,
      reserved.amountPence,
    )
    return reserved.payoutId
  }

  // Txn 1: reserve — insert a 'pending' writer_payouts row and claim the
  // writer's unpaid earnings under it. Commits before any Stripe call, so the
  // audit trail exists even if the process dies mid-flight.
  private async reserveWriterPayout(
    writerId: string,
    stripeConnectId: string,
    expectedAmountPence: number,
  ): Promise<{ payoutId: string; amountPence: number } | null> {
    return withTransaction(async (client) => {
      await client.query(
        'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
        [writerId],
      )

      const config = await loadConfig()
      // Authoritative (locked) recompute of the same net the eligibility query
      // used: base per-read/upvote net − ROOT tribute carve (the author's direct
      // children, state-agnostic, on the settled-unpaid reads) + swept ROOT
      // returns owed to this author. The swept accruals are CLAIMED below under
      // swept_return_payout_id (kind 'writer'); the carved accruals stay tied to
      // their reads (their disposition is the root inspirer's payout or a later
      // sweep). Tribute subqueries are no-ops when dark.
      const balanceRow = await client.query<{ net_pence: string }>(
        `SELECT (
           (SELECT COALESCE(SUM(${readNetSql('amount_pence', '$2')}), 0)
              FROM (
                SELECT amount_pence FROM read_events
                WHERE writer_id = $1 AND state = 'platform_settled' AND writer_payout_id IS NULL
                UNION ALL
                SELECT amount_pence FROM vote_charges
                WHERE recipient_id = $1 AND state = 'platform_settled' AND writer_payout_id IS NULL
              ) AS earnings)
           - (SELECT COALESCE(SUM(ta.amount_pence), 0)
                FROM tribute_accruals ta
                JOIN read_events re ON re.id = ta.read_event_id
                JOIN tributes t ON t.id = ta.tribute_id
                WHERE re.writer_id = $1 AND re.state = 'platform_settled' AND re.writer_payout_id IS NULL
                  AND t.parent_tribute_id IS NULL)
           + (SELECT COALESCE(SUM(ta.amount_pence), 0)
                FROM tribute_accruals ta
                JOIN tributes t ON t.id = ta.tribute_id
                WHERE t.author_account_id = $1 AND ta.state = 'swept' AND ta.swept_return_payout_id IS NULL
                  AND t.parent_tribute_id IS NULL)
         ) AS net_pence`,
        [writerId, config.platformFeeBps],
      )

      const lockedAmountPence = parseInt(balanceRow.rows[0].net_pence, 10)

      if (lockedAmountPence <= 0) {
        logger.warn(
          { writerId, expected: expectedAmountPence },
          'Writer has no unreserved balance — skipping (likely claimed by a pending payout)',
        )
        return null
      }

      if (lockedAmountPence !== expectedAmountPence) {
        logger.warn(
          { writerId, expected: expectedAmountPence, actual: lockedAmountPence },
          'Balance changed between eligibility check and lock — using locked amount',
        )
      }

      const payoutRow = await client.query<{ id: string }>(
        `INSERT INTO writer_payouts (
           writer_id, amount_pence, stripe_connect_id, status
         ) VALUES ($1, $2, $3, 'pending')
         RETURNING id`,
        [writerId, lockedAmountPence, stripeConnectId],
      )
      const payoutId = payoutRow.rows[0].id

      await client.query(
        `UPDATE read_events
         SET writer_payout_id = $1
         WHERE writer_id = $2
           AND state = 'platform_settled'
           AND writer_payout_id IS NULL`,
        [payoutId, writerId],
      )

      await client.query(
        `UPDATE vote_charges
         SET writer_payout_id = $1
         WHERE recipient_id = $2
           AND state = 'platform_settled'
           AND writer_payout_id IS NULL`,
        [payoutId, writerId],
      )

      // Claim the swept (declined/lapsed) ROOT tribute shares owed back to this
      // author under the payout via the generic swept-return vehicle (kind
      // 'writer' — the author is the depth-0 parent; deeper nodes use kind
      // 'tribute'). State stays 'swept' until completeWriterPayout advances it to
      // 'returned'; a failed transfer rolls the claim back. The lockedAmountPence
      // above already includes their sum.
      await client.query(
        `UPDATE tribute_accruals ta
            SET swept_return_payout_id = $1, swept_return_kind = 'writer'
           FROM tributes t
          WHERE t.id = ta.tribute_id
            AND t.author_account_id = $2
            AND t.parent_tribute_id IS NULL
            AND ta.state = 'swept'
            AND ta.swept_return_payout_id IS NULL`,
        [payoutId, writerId],
      )

      logger.info(
        { payoutId, writerId, amountPence: lockedAmountPence },
        'Writer payout reserved (pending Stripe transfer)',
      )

      return { payoutId, amountPence: lockedAmountPence }
    })
  }

  // Stripe call + Txn 2: flip 'pending' → 'initiated', advance reserved rows
  // to writer_paid. Uses stable idempotencyKey `payout-${payoutId}` so a retry
  // after a crash lands on the same Stripe transfer rather than creating a
  // duplicate.
  private async completeWriterPayout(
    payoutId: string,
    writerId: string,
    stripeConnectId: string,
    amountPence: number,
  ): Promise<void> {
    const transfer = await this.stripe.transfers.create({
      amount: amountPence,
      currency: 'gbp',
      destination: stripeConnectId,
      metadata: {
        platform: 'all.haus',
        writer_id: writerId,
        payout_id: payoutId,
      },
    }, {
      idempotencyKey: `payout-${payoutId}`,
    })

    await withTransaction(async (client) => {
      // Guard the status flip on status='pending' and use its rowCount to gate
      // the ledger emit. completeWriterPayout is re-run on crash-resume with a
      // stable Stripe key, so only the FIRST txn that actually flips
      // pending→initiated must post the (one) ledger entry — otherwise a resume
      // double-counts the payout.
      const flipped = await client.query(
        `UPDATE writer_payouts
         SET status = 'initiated', stripe_transfer_id = $1
         WHERE id = $2 AND status = 'pending'`,
        [transfer.id, payoutId],
      )

      await client.query(
        `UPDATE read_events
         SET state = 'writer_paid',
             state_updated_at = now()
         WHERE writer_payout_id = $1
           AND state = 'platform_settled'`,
        [payoutId],
      )

      await client.query(
        `UPDATE vote_charges
         SET state = 'writer_paid'
         WHERE writer_payout_id = $1
           AND state = 'platform_settled'`,
        [payoutId],
      )

      // Advance the swept ROOT tribute shares claimed by this payout to 'returned'
      // (their value is part of the transfer + the writer_payout ledger entry
      // below). Idempotent on resume: no rows remain in 'swept' once flipped.
      await client.query(
        `UPDATE tribute_accruals
         SET state = 'returned'
         WHERE swept_return_payout_id = $1
           AND swept_return_kind = 'writer'
           AND state = 'swept'`,
        [payoutId],
      )

      // Ledger: writer credit — money received. +amount, counterparty =
      // platform (NULL). SUM of these == historic writer payout sums. Gated on
      // the pending→initiated flip so resume can't post it twice.
      if (flipped.rowCount! > 0) {
        await recordLedger(client, {
          accountId: writerId,
          counterpartyId: null,
          amountPence: amountPence,
          triggerType: 'writer_payout',
          refTable: 'writer_payouts',
          refId: payoutId,
        })
      }
    })

    logger.info(
      { payoutId, writerId, amountPence, stripeTransferId: transfer.id },
      'Writer payout initiated',
    )
  }

  // Resume any writer_payouts stuck in 'pending' from prior runs. Safe to
  // call repeatedly — the stable idempotency key means Stripe returns the
  // already-created transfer if one exists, or creates it exactly once.
  async resumePendingWriterPayouts(): Promise<void> {
    const { rows } = await pool.query<{
      id: string
      writer_id: string
      amount_pence: number
      stripe_connect_id: string
    }>(
      `SELECT id, writer_id, amount_pence, stripe_connect_id
       FROM writer_payouts
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    )

    if (rows.length === 0) return

    logger.info({ count: rows.length }, 'Resuming pending writer payouts')

    for (const row of rows) {
      try {
        await this.completeWriterPayout(
          row.id,
          row.writer_id,
          row.stripe_connect_id,
          row.amount_pence,
        )
      } catch (err) {
        logger.error(
          { err, payoutId: row.id, writerId: row.writer_id },
          'Failed to resume pending writer payout — will retry next cycle',
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // confirmPayout — called from Stripe webhook on transfer.paid
  //
  // FIX #14: Changed from transfer.created to transfer.paid. transfer.created
  // fires when Stripe creates the transfer object, not when funds arrive.
  // Marking a payout as 'completed' should only happen when the transfer
  // actually lands.
  // ---------------------------------------------------------------------------

  async confirmPayout(stripeTransferId: string): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE writer_payouts
       SET status = 'completed', completed_at = now()
       WHERE stripe_transfer_id = $1
         AND status != 'completed'
       RETURNING id`,
      [stripeTransferId]
    )

    if (rows.length === 0) {
      // Either the webhook fired for an unknown transfer, or the row was
      // already 'completed' (duplicate delivery — Stripe retries 3× on 2xx
      // failures). Both are safe no-ops, but worth logging: an unknown
      // transfer ID in production may indicate a mis-routed webhook.
      logger.warn({ stripeTransferId }, 'confirmPayout: no row updated')
      return
    }

    logger.info({ stripeTransferId, payoutId: rows[0].id }, 'Writer payout confirmed')
  }

  // ---------------------------------------------------------------------------
  // handleFailedPayout — called from Stripe webhook on transfer.failed
  // Rolls reads back to platform_settled so they are retried on next cycle
  // ---------------------------------------------------------------------------

  async handleFailedPayout(stripeTransferId: string, reason: string): Promise<void> {
    await withTransaction(async (client) => {
      // A payout that previously reached 'completed' (e.g. a transfer.paid
      // webhook that later reversed) needs completed_at nulled out alongside
      // the status flip — otherwise reporting shows the payout as both failed
      // and completed at some historical timestamp. failed_reason is only
      // overwritten when empty so a subsequent retry doesn't lose the first
      // failure's context.
      const payoutRow = await client.query<{ id: string; writer_id: string }>(
        `UPDATE writer_payouts
         SET status = 'failed',
             failed_reason = COALESCE(failed_reason, $1),
             completed_at = NULL
         WHERE stripe_transfer_id = $2
         RETURNING id, writer_id`,
        [reason, stripeTransferId]
      )

      if (payoutRow.rowCount === 0) return

      const { id: payoutId, writer_id: writerId } = payoutRow.rows[0]

      // Roll reads back to platform_settled — they'll be picked up by next cycle
      await client.query(
        `UPDATE read_events
         SET state = 'platform_settled',
             writer_payout_id = NULL,
             state_updated_at = now()
         WHERE writer_payout_id = $1`,
        [payoutId]
      )

      // Roll vote_charges back to platform_settled
      await client.query(
        `UPDATE vote_charges
         SET state = 'platform_settled',
             writer_payout_id = NULL
         WHERE writer_payout_id = $1`,
        [payoutId]
      )

      // Unclaim the swept tribute shares this payout carried back to the author
      // (whether or not completeWriterPayout already advanced them to 'returned')
      // so the next cycle returns them again. Mirrors the read rollback above.
      // Kind 'writer' — a writer_payout only ever claims root swept returns.
      await client.query(
        `UPDATE tribute_accruals
         SET state = 'swept',
             swept_return_payout_id = NULL,
             swept_return_kind = NULL
         WHERE swept_return_payout_id = $1
           AND swept_return_kind = 'writer'`,
        [payoutId]
      )

      logger.warn({ payoutId, writerId, stripeTransferId, reason }, 'Writer payout failed — reads rolled back')
    })
  }

  // ===========================================================================
  // Publication Payout Cycle (Phase 5)
  //
  // Runs after the individual writer cycle. For each publication with enough
  // settled revenue:
  //   1. Compute the pool (gross reads minus platform fee)
  //   2. Handle per-article overrides (flat fees, article revenue shares)
  //   3. Distribute remainder by standing member shares
  //   4. Initiate Stripe transfers to each member's personal Connect account
  // ===========================================================================

  async runPublicationPayoutCycle(): Promise<{ processed: number; totalPaidPence: number }> {
    // Resume any pending publication payouts from prior runs before taking on
    // new work. Stable idempotency keys on per-split transfers make this safe
    // to call repeatedly — Stripe deduplicates if the transfer already exists.
    await this.resumePendingPublicationPayouts()

    const config = await loadConfig()

    // Find publications with enough settled revenue
    const { rows: eligiblePubs } = await pool.query<{
      publication_id: string
      gross_pence: string
    }>(
      `SELECT a.publication_id, SUM(r.amount_pence) AS gross_pence
       FROM read_events r
       JOIN articles a ON a.id = r.article_id
       WHERE a.publication_id IS NOT NULL
         AND r.state = 'platform_settled'
         AND r.writer_payout_id IS NULL
       GROUP BY a.publication_id
       HAVING SUM(r.amount_pence - FLOOR(r.amount_pence * $1 / 10000)) >= $2`,
      [config.platformFeeBps, config.writerPayoutThresholdPence]
    )

    let processed = 0
    let totalPaidPence = 0

    for (const pub of eligiblePubs) {
      try {
        const paidPence = await this.initiatePublicationPayout(
          pub.publication_id,
          parseInt(pub.gross_pence, 10),
          config.platformFeeBps,
        )
        if (paidPence !== null) {
          processed++
          totalPaidPence += paidPence
        }
      } catch (err) {
        logger.error({ err, publicationId: pub.publication_id }, 'Publication payout failed — continuing cycle')
      }
    }

    logger.info({ processed, totalPaidPence }, 'Publication payout cycle complete')
    return { processed, totalPaidPence }
  }

  // ---------------------------------------------------------------------------
  // initiatePublicationPayout — single publication payout
  //
  // FIX-PROGRAMME §4: Same orphan shape as writer payouts (§3), N-multiplied
  // across splits. Earlier the whole flow ran inside one transaction with
  // Stripe transfers issued mid-loop; any later throw rolled back the split
  // rows while N transfers stayed live. Now:
  //
  //   1. reservePublicationPayout (Txn 1) — insert publication_payouts row as
  //      'pending', insert all splits as 'pending', mark flat-fee shares as
  //      paid_out, and stamp read_events with writer_payout_id so another
  //      cycle can't re-count the same reads.
  //   2. processPublicationSplits — per-split Stripe call with stable
  //      idempotencyKey=`pub-split-${payoutId}-${accountId}`, each split
  //      status update in its own small transaction. Stripe throw flips only
  //      that split to 'failed'; other splits are unaffected.
  //   3. finalisePublicationPayout (Txn 2) — advance reserved reads to
  //      writer_paid and flip the payout row to 'initiated'.
  //
  // Crashes between steps → resumePendingPublicationPayouts on next cycle
  // retries only the splits still in 'pending' (initiated/failed splits are
  // skipped), then finalises.
  //
  // Subsumes §33: the earlier dead "mark completed" block at the end of
  // initiatePublicationPayout is replaced by finalisePublicationPayout's
  // deterministic status flip.
  // ---------------------------------------------------------------------------

  private async initiatePublicationPayout(
    publicationId: string,
    _grossPence: number,
    feeBps: number,
  ): Promise<number | null> {
    const reserved = await this.reservePublicationPayout(publicationId, feeBps)
    if (!reserved) return null

    const totalTransferred = await this.processPublicationSplits(reserved.payoutId)
    await this.finalisePublicationPayout(reserved.payoutId, publicationId)

    logger.info(
      { payoutId: reserved.payoutId, publicationId, totalTransferred },
      'Publication payout initiated',
    )
    return totalTransferred
  }

  // Txn 1: reserve — insert a 'pending' publication_payouts row, insert all
  // splits as 'pending', mark flat-fee shares paid_out, stamp read_events
  // under the payout. Commits before any Stripe call.
  private async reservePublicationPayout(
    publicationId: string,
    feeBps: number,
  ): Promise<{ payoutId: string } | null> {
    return withTransaction(async (client) => {
      await client.query(
        'SELECT id FROM publications WHERE id = $1 FOR UPDATE',
        [publicationId],
      )

      const { rows: [balRow] } = await client.query<{ gross_pence: string }>(
        `SELECT COALESCE(SUM(r.amount_pence), 0) AS gross_pence
         FROM read_events r
         JOIN articles a ON a.id = r.article_id
         WHERE a.publication_id = $1
           AND r.state = 'platform_settled'
           AND r.writer_payout_id IS NULL`,
        [publicationId],
      )

      const lockedGross = parseInt(balRow.gross_pence, 10)
      if (lockedGross <= 0) {
        logger.warn(
          { publicationId },
          'Publication has no unreserved revenue — skipping (likely claimed by a pending payout)',
        )
        return null
      }

      // --- Load per-article overrides ---
      const { rows: articleShareRows } = await client.query<{
        id: string; article_id: string; account_id: string;
        share_type: string; share_value: number; paid_out: boolean;
      }>(
        `SELECT pas.id, pas.article_id, pas.account_id, pas.share_type, pas.share_value, pas.paid_out
         FROM publication_article_shares pas
         JOIN articles a ON a.id = pas.article_id
         WHERE pas.publication_id = $1`,
        [publicationId],
      )

      const articleIds = [...new Set(articleShareRows.map(s => s.article_id))]
      const articleEarnings = new Map<string, number>()

      if (articleIds.length > 0) {
        const { rows: artRows } = await client.query<{ article_id: string; net_pence: string }>(
          `SELECT r.article_id,
                  COALESCE(SUM(r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)), 0) AS net_pence
           FROM read_events r
           WHERE r.article_id = ANY($1)
             AND r.state = 'platform_settled'
             AND r.writer_payout_id IS NULL
           GROUP BY r.article_id`,
          [articleIds, feeBps],
        )
        for (const r of artRows) {
          articleEarnings.set(r.article_id, parseInt(r.net_pence, 10))
        }
      }

      // --- Load standing shares ---
      const { rows: standingRows } = await client.query<{
        account_id: string; revenue_share_bps: number;
      }>(
        `SELECT account_id, revenue_share_bps
         FROM publication_members
         WHERE publication_id = $1 AND removed_at IS NULL AND revenue_share_bps > 0`,
        [publicationId],
      )

      // Delegate allocation to the pure function so production and unit tests
      // execute the same code path.
      const articleShares: ArticleShare[] = articleShareRows.map(r => ({
        id: r.id,
        articleId: r.article_id,
        accountId: r.account_id,
        shareType: r.share_type as 'flat_fee_pence' | 'revenue_bps',
        shareValue: r.share_value,
        paidOut: r.paid_out,
      }))
      const standingMembers: StandingMember[] = standingRows.map(r => ({
        accountId: r.account_id,
        revenueShareBps: r.revenue_share_bps,
      }))

      const { platformFeePence, splits, remainingPool, flatFeesPaidPence, flatFeeShareIds } =
        computePublicationSplits(lockedGross, feeBps, articleShares, articleEarnings, standingMembers)

      // --- Insert publication_payouts as pending ---
      const { rows: [payoutRow] } = await client.query<{ id: string }>(
        `INSERT INTO publication_payouts
           (publication_id, total_pool_pence, platform_fee_pence, flat_fees_paid_pence, remaining_pool_pence, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id`,
        [publicationId, lockedGross, platformFeePence, flatFeesPaidPence, remainingPool],
      )
      const payoutId = payoutRow.id

      // --- Insert all splits as pending ---
      for (const split of splits) {
        if (split.amountPence <= 0) continue
        await client.query(
          `INSERT INTO publication_payout_splits
             (publication_payout_id, account_id, share_bps, amount_pence, share_type, article_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
          [payoutId, split.accountId, split.shareBps, split.amountPence,
           split.shareType, split.articleId],
        )
      }

      // --- Reserve flat-fee shares and read_events under this payout ---
      if (flatFeeShareIds.length > 0) {
        await client.query(
          `UPDATE publication_article_shares SET paid_out = TRUE WHERE id = ANY($1)`,
          [flatFeeShareIds],
        )
      }

      await client.query(
        `UPDATE read_events
         SET writer_payout_id = $1
         FROM articles a
         WHERE read_events.article_id = a.id
           AND a.publication_id = $2
           AND read_events.state = 'platform_settled'
           AND read_events.writer_payout_id IS NULL`,
        [payoutId, publicationId],
      )

      logger.info(
        { payoutId, publicationId, grossPence: lockedGross, platformFeePence, splits: splits.length },
        'Publication payout reserved (pending Stripe transfers)',
      )

      return { payoutId }
    })
  }

  // Stripe loop: for each split still in 'pending', call Stripe with a stable
  // idempotency key and flip the split to 'initiated' or 'failed'. Each split
  // is independent — one failure doesn't poison the others. KYC-incomplete
  // accounts stay pending until the next cycle retries them.
  private async processPublicationSplits(payoutId: string): Promise<number> {
    const { rows: pendingSplits } = await pool.query<{
      id: string; account_id: string; amount_pence: number;
    }>(
      `SELECT id, account_id, amount_pence
       FROM publication_payout_splits
       WHERE publication_payout_id = $1
         AND status = 'pending'
         AND amount_pence > 0
       ORDER BY id ASC`,
      [payoutId],
    )

    let totalTransferred = 0

    for (const split of pendingSplits) {
      const { rows: accRows } = await pool.query<{
        stripe_connect_id: string | null; stripe_connect_kyc_complete: boolean;
      }>(
        `SELECT stripe_connect_id, stripe_connect_kyc_complete FROM accounts WHERE id = $1`,
        [split.account_id],
      )

      const acc = accRows[0]
      if (!acc?.stripe_connect_id || !acc.stripe_connect_kyc_complete) {
        // Leave pending — next cycle will retry once KYC completes
        continue
      }

      try {
        const transfer = await this.stripe.transfers.create({
          amount: split.amount_pence,
          currency: 'gbp',
          destination: acc.stripe_connect_id,
          metadata: {
            platform: 'all.haus',
            publication_payout_id: payoutId,
            split_id: split.id,
            account_id: split.account_id,
          },
        }, {
          idempotencyKey: `pub-split-${payoutId}-${split.account_id}`,
        })

        // Flip the split and post its ledger entry in ONE txn so they commit
        // together: if the flip committed but the entry didn't, the split would
        // never be re-selected (the loop only picks 'pending') and the credit
        // would be lost. Gated on the pending→initiated flip for idempotency.
        await withTransaction(async (client) => {
          const flipped = await client.query(
            `UPDATE publication_payout_splits
             SET status = 'initiated', stripe_transfer_id = $1
             WHERE id = $2 AND status = 'pending'`,
            [transfer.id, split.id],
          )
          if (flipped.rowCount! > 0) {
            // Ledger: publication-member credit — money received. +amount,
            // counterparty = platform (NULL). SUM == historic split sums.
            await recordLedger(client, {
              accountId: split.account_id,
              counterpartyId: null,
              amountPence: split.amount_pence,
              triggerType: 'publication_split',
              refTable: 'publication_payout_splits',
              refId: split.id,
            })
          }
        })
        totalTransferred += split.amount_pence
      } catch (err) {
        logger.error(
          { err, splitId: split.id, accountId: split.account_id, payoutId },
          'Stripe transfer failed for publication split',
        )
        await pool.query(
          `UPDATE publication_payout_splits SET status = 'failed' WHERE id = $1`,
          [split.id],
        )
      }
    }

    return totalTransferred
  }

  // Txn 2: advance reserved read_events to writer_paid and flip the payout
  // row to 'initiated'. Safe to call repeatedly — both UPDATEs are
  // idempotent (WHERE status='platform_settled' / no-op on already-initiated).
  private async finalisePublicationPayout(
    payoutId: string,
    publicationId: string,
  ): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE read_events
         SET state = 'writer_paid', state_updated_at = now()
         FROM articles a
         WHERE read_events.article_id = a.id
           AND a.publication_id = $1
           AND read_events.writer_payout_id = $2
           AND read_events.state = 'platform_settled'`,
        [publicationId, payoutId],
      )

      await client.query(
        `UPDATE publication_payouts SET status = 'initiated' WHERE id = $1 AND status = 'pending'`,
        [payoutId],
      )
    })
  }

  // Resume publication_payouts stuck in 'pending' from prior runs. Retries
  // pending splits (stable idempotency keys make this safe) and finalises.
  async resumePendingPublicationPayouts(): Promise<void> {
    const { rows } = await pool.query<{ id: string; publication_id: string }>(
      `SELECT id, publication_id
       FROM publication_payouts
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    )

    if (rows.length === 0) return

    logger.info({ count: rows.length }, 'Resuming pending publication payouts')

    for (const row of rows) {
      try {
        await this.processPublicationSplits(row.id)
        await this.finalisePublicationPayout(row.id, row.publication_id)
      } catch (err) {
        logger.error(
          { err, payoutId: row.id, publicationId: row.publication_id },
          'Failed to resume pending publication payout — will retry next cycle',
        )
      }
    }
  }

  // ===========================================================================
  // Tribute Payout Cycle (Upstream Edges Phase 3)
  //
  // Pays each consented inspirer the share redirected to them. Runs after the
  // writer + publication cycles (the author's carve and swept-return are handled
  // inside runPayoutCycle). Dark behind TRIBUTES_ENABLED.
  //
  // Per-tribute, mirroring the writer-payout three-phase durability:
  //   1. reserveTributePayout (Txn 1) — insert 'pending' tribute_payouts row and
  //      claim the tribute's released accruals under it (tribute_payout_id), so
  //      no concurrent cycle re-counts them.
  //   2. stripe.transfers.create, idempotencyKey=`tribute-payout-${payoutId}`
  //      (stable — a retry after a crash lands on the same transfer).
  //   3. completeTributePayout (Txn 2) — flip 'initiated' + store transfer id,
  //      advance the claimed accruals released→paid, post ONE tribute_payout
  //      ledger entry (account = inspirer, counterparty = author). No mirrored
  //      debit — the author's reduced writer_payout already reflects the carve.
  //
  // A crash between 1 and 3 leaves the row 'pending'; resumePendingTributePayouts
  // (called at cycle start) re-runs 2–3 with the same stable key.
  // ===========================================================================

  async runTributePayoutCycle(): Promise<{ processed: number; totalPaidPence: number }> {
    if (!tributesEnabled()) return { processed: 0, totalPaidPence: 0 }

    await this.resumePendingTributePayouts()

    // Eligible: a live tribute whose resolved inspirer is Connect-onboarded and
    // has EITHER released-unclaimed accruals (fresh inflow to pay out) OR direct
    // children whose swept share is owed back to it (C5 return to fold in) — the
    // inspirer mirror of the author's `base ∪ ret` candidate set. No payout
    // threshold — the share is the inspirer's the moment it releases (the
    // author's read already cleared the £20 floor to settle). The exact amount
    // (gross − direct-children carve + child swept-returns) is recomputed under
    // lock in reserveTributePayout, so this only finds candidates.
    const { rows: eligible } = await pool.query<{
      tribute_id: string
      inspirer_account_id: string
      author_account_id: string
      stripe_connect_id: string
    }>(
      `WITH released AS (
         SELECT tribute_id FROM tribute_accruals
         WHERE state = 'released' AND tribute_payout_id IS NULL
         GROUP BY tribute_id
       ),
       returns AS (
         -- A deeper child's swept share returns up one level to its PARENT
         -- inspirer node (C5). Root swept shares (parent NULL) go to the author's
         -- writer cycle, not here.
         SELECT t.parent_tribute_id AS tribute_id
         FROM tribute_accruals ta
         JOIN tributes t ON t.id = ta.tribute_id
         WHERE ta.state = 'swept' AND ta.swept_return_payout_id IS NULL
           AND t.parent_tribute_id IS NOT NULL
         GROUP BY t.parent_tribute_id
       ),
       candidates AS (
         SELECT tribute_id FROM released
         UNION
         SELECT tribute_id FROM returns
       )
       SELECT t.id AS tribute_id,
              t.resolved_account_id AS inspirer_account_id,
              t.author_account_id,
              insp.stripe_connect_id
       FROM candidates c
       JOIN tributes t ON t.id = c.tribute_id
       JOIN accounts insp ON insp.id = t.resolved_account_id
       WHERE t.status = 'live'
         AND insp.stripe_connect_kyc_complete = TRUE
         AND insp.stripe_connect_id IS NOT NULL`,
    )

    let processed = 0
    let totalPaidPence = 0

    for (const row of eligible) {
      try {
        const paid = await this.initiateTributePayout(
          row.tribute_id,
          row.inspirer_account_id,
          row.author_account_id,
          row.stripe_connect_id,
        )
        if (paid !== null) {
          processed++
          totalPaidPence += paid
        }
      } catch (err) {
        logger.error({ err, tributeId: row.tribute_id }, 'Tribute payout failed — continuing cycle')
      }
    }

    logger.info({ processed, totalPaidPence }, 'Tribute payout cycle complete')
    return { processed, totalPaidPence }
  }

  private async initiateTributePayout(
    tributeId: string,
    inspirerId: string,
    authorId: string,
    stripeConnectId: string,
  ): Promise<number | null> {
    const reserved = await this.reserveTributePayout(tributeId, inspirerId, authorId)
    if (!reserved) return null

    await this.completeTributePayout(
      reserved.payoutId,
      tributeId,
      inspirerId,
      authorId,
      stripeConnectId,
      reserved.amountPence,
    )
    return reserved.amountPence
  }

  // Txn 1: lock the tribute, compute its LEVEL-AWARE net, insert a 'pending'
  // tribute_payouts row, and claim the rows that net feeds on. Commits before any
  // Stripe call.
  //
  // This node N is now a co-earner exactly like the author at depth 0 — its net
  // is its gross inflow minus its DIRECT children's gross plus any child swept
  // shares owed back (C5):
  //   net = Σ(N's released-unclaimed accruals)              (N's gross inflow)
  //       − Σ(N's direct children's accruals on those reads) (the onward carve)
  //       + Σ(N's direct children's swept-unclaimed accruals) (C5 returns to N)
  // The carve is scoped to the reads N is claiming this cycle (a child accrual is
  // carved exactly once — when N's accrual on that read is claimed), state-agnostic
  // (each child's disposition is its own leg). The ceiling guarantees children
  // take ≤90% of N's inflow, so net stays positive. N's released accruals are
  // claimed under tribute_payout_id (like the author claims reads); the child
  // swept returns are claimed under swept_return_payout_id (kind 'tribute').
  private async reserveTributePayout(
    tributeId: string,
    inspirerId: string,
    authorId: string,
  ): Promise<{ payoutId: string; amountPence: number } | null> {
    return withTransaction(async (client) => {
      await client.query('SELECT id FROM tributes WHERE id = $1 FOR UPDATE', [tributeId])

      const { rows: [bal] } = await client.query<{
        gross_released: string
        child_carve: string
        swept_return: string
      }>(
        `SELECT
           (SELECT COALESCE(SUM(amount_pence), 0)
              FROM tribute_accruals
             WHERE tribute_id = $1 AND state = 'released' AND tribute_payout_id IS NULL)
             AS gross_released,
           (SELECT COALESCE(SUM(ca.amount_pence), 0)
              FROM tribute_accruals ca
              JOIN tributes ct ON ct.id = ca.tribute_id
             WHERE ct.parent_tribute_id = $1
               AND ca.read_event_id IN (
                 SELECT read_event_id FROM tribute_accruals
                  WHERE tribute_id = $1 AND state = 'released' AND tribute_payout_id IS NULL))
             AS child_carve,
           (SELECT COALESCE(SUM(ca.amount_pence), 0)
              FROM tribute_accruals ca
              JOIN tributes ct ON ct.id = ca.tribute_id
             WHERE ct.parent_tribute_id = $1
               AND ca.state = 'swept' AND ca.swept_return_payout_id IS NULL)
             AS swept_return`,
        [tributeId],
      )
      const amountPence =
        parseInt(bal.gross_released, 10) - parseInt(bal.child_carve, 10) + parseInt(bal.swept_return, 10)
      if (amountPence <= 0) {
        logger.warn({ tributeId }, 'Tribute has no payable net this cycle — skipping (likely claimed by a pending payout)')
        return null
      }

      const { rows: [payoutRow] } = await client.query<{ id: string }>(
        `INSERT INTO tribute_payouts
           (tribute_id, inspirer_account_id, author_account_id, amount_pence, status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING id`,
        [tributeId, inspirerId, authorId, amountPence],
      )
      const payoutId = payoutRow.id

      // Claim N's own released accruals (its gross inflow being paid).
      await client.query(
        `UPDATE tribute_accruals
         SET tribute_payout_id = $1
         WHERE tribute_id = $2 AND state = 'released' AND tribute_payout_id IS NULL`,
        [payoutId, tributeId],
      )

      // Claim N's direct children's swept shares owed back to N (C5), via the
      // generic swept-return vehicle, kind 'tribute'. State stays 'swept' until
      // completeTributePayout advances it to 'returned'.
      await client.query(
        `UPDATE tribute_accruals ca
            SET swept_return_payout_id = $1, swept_return_kind = 'tribute'
           FROM tributes ct
          WHERE ct.id = ca.tribute_id
            AND ct.parent_tribute_id = $2
            AND ca.state = 'swept'
            AND ca.swept_return_payout_id IS NULL`,
        [payoutId, tributeId],
      )

      logger.info({ payoutId, tributeId, amountPence }, 'Tribute payout reserved (pending Stripe transfer)')
      return { payoutId, amountPence }
    })
  }

  // Stripe transfer (stable key) + Txn 2: flip 'pending'→'initiated', advance the
  // claimed accruals released→paid, post one tribute_payout ledger entry. A
  // throw before/within leaves the row 'pending' for resume (same key dedupes).
  private async completeTributePayout(
    payoutId: string,
    tributeId: string,
    inspirerId: string,
    authorId: string,
    stripeConnectId: string,
    amountPence: number,
  ): Promise<void> {
    const transfer = await this.stripe.transfers.create({
      amount: amountPence,
      currency: 'gbp',
      destination: stripeConnectId,
      metadata: {
        platform: 'all.haus',
        tribute_payout_id: payoutId,
        tribute_id: tributeId,
        inspirer_account_id: inspirerId,
      },
    }, {
      idempotencyKey: `tribute-payout-${payoutId}`,
    })

    await withTransaction(async (client) => {
      const flipped = await client.query(
        `UPDATE tribute_payouts
         SET status = 'initiated', stripe_transfer_id = $1
         WHERE id = $2 AND status = 'pending'`,
        [transfer.id, payoutId],
      )

      await client.query(
        `UPDATE tribute_accruals
         SET state = 'paid'
         WHERE tribute_payout_id = $1 AND state = 'released'`,
        [payoutId],
      )

      // Advance the direct children's swept shares this payout carried back to
      // this node (C5, kind 'tribute') to 'returned' — their value is part of the
      // transfer + the ledger entry below. Idempotent on resume.
      await client.query(
        `UPDATE tribute_accruals
         SET state = 'returned'
         WHERE swept_return_payout_id = $1
           AND swept_return_kind = 'tribute'
           AND state = 'swept'`,
        [payoutId],
      )

      // Ledger: inspirer credit — the redirected share received (net of its own
      // onward carve). +amount, counterparty = the party whose share was
      // redirected (this node's author_account_id — the article author for a
      // root, the parent inspirer for a deeper node). Counted by
      // ledger_writer_earnings (migration 127). Gated on the pending→initiated
      // flip so resume can't post it twice.
      if (flipped.rowCount! > 0) {
        await recordLedger(client, {
          accountId: inspirerId,
          counterpartyId: authorId,
          amountPence,
          triggerType: 'tribute_payout',
          refTable: 'tribute_payouts',
          refId: payoutId,
        })
      }
    })

    logger.info(
      { payoutId, tributeId, inspirerId, amountPence, stripeTransferId: transfer.id },
      'Tribute payout initiated',
    )
  }

  // Resume tribute_payouts stuck in 'pending' from prior runs. Safe to call
  // repeatedly — the stable idempotency key dedupes the Stripe transfer.
  async resumePendingTributePayouts(): Promise<void> {
    const { rows } = await pool.query<{
      id: string
      tribute_id: string
      inspirer_account_id: string
      author_account_id: string
      amount_pence: number
    }>(
      `SELECT id, tribute_id, inspirer_account_id, author_account_id, amount_pence
       FROM tribute_payouts
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    )

    if (rows.length === 0) return

    logger.info({ count: rows.length }, 'Resuming pending tribute payouts')

    for (const row of rows) {
      try {
        const { rows: accRows } = await pool.query<{
          stripe_connect_id: string | null
          stripe_connect_kyc_complete: boolean
        }>(
          `SELECT stripe_connect_id, stripe_connect_kyc_complete FROM accounts WHERE id = $1`,
          [row.inspirer_account_id],
        )
        const acc = accRows[0]
        if (!acc?.stripe_connect_id || !acc.stripe_connect_kyc_complete) {
          logger.warn(
            { tributePayoutId: row.id },
            'Cannot resume tribute payout — inspirer no longer onboarded; leaving pending',
          )
          continue
        }
        await this.completeTributePayout(
          row.id,
          row.tribute_id,
          row.inspirer_account_id,
          row.author_account_id,
          acc.stripe_connect_id,
          row.amount_pence,
        )
      } catch (err) {
        logger.error(
          { err, tributePayoutId: row.id },
          'Failed to resume tribute payout — will retry next cycle',
        )
      }
    }
  }
}

export const payoutService = new PayoutService()
