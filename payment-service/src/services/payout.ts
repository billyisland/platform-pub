import Stripe from 'stripe'
import type { WriterEarnings, ArticleEarnings } from '../types/index.js'
import { pool, withTransaction, loadConfig } from '../../shared/src/db/client.js'
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

export interface Split {
  accountId: string
  amountPence: number
  shareType: string
  shareBps: number | null
  articleId: string | null
}

export interface SplitResult {
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

export class PayoutService {
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
      read_count: string
    }>(
      `SELECT
         COALESCE(SUM(
           CASE
             WHEN r.state = 'writer_paid' THEN r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)
             WHEN r.state = 'platform_settled' THEN r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)
             ELSE 0
           END
         ), 0) AS earnings_total_pence,
         COALESCE(SUM(
           CASE WHEN r.state = 'platform_settled'
             THEN r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)
             ELSE 0
           END
         ), 0) AS pending_transfer_pence,
         COALESCE(SUM(
           CASE WHEN r.state = 'writer_paid'
             THEN r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)
             ELSE 0
           END
         ), 0) AS paid_out_pence,
         COUNT(*) AS read_count
       FROM read_events r
       WHERE r.writer_id = $1
         AND r.state IN ('platform_settled', 'writer_paid')`,
      [writerId, config.platformFeeBps]
    )

    const row = rows[0]

    return {
      writerId,
      earningsTotalPence: parseInt(row.earnings_total_pence, 10),
      pendingTransferPence: parseInt(row.pending_transfer_pence, 10),
      paidOutPence: parseInt(row.paid_out_pence, 10),
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
         COALESCE(SUM(r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)), 0) AS net_earnings_pence,
         COALESCE(SUM(CASE WHEN r.state = 'platform_settled'
           THEN r.amount_pence - FLOOR(r.amount_pence * $2 / 10000) ELSE 0 END), 0) AS pending_pence,
         COALESCE(SUM(CASE WHEN r.state = 'writer_paid'
           THEN r.amount_pence - FLOOR(r.amount_pence * $2 / 10000) ELSE 0 END), 0) AS paid_pence
       FROM read_events r
       JOIN articles a ON a.id = r.article_id
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
    // FIX #4: Compute net amounts (after platform fee) for payout eligibility
    const { rows: eligibleWriters } = await pool.query<{
      writer_id: string
      gross_pence: string
      net_pence: string
      stripe_connect_id: string
    }>(
      `SELECT
         earnings.writer_id,
         SUM(earnings.amount_pence) AS gross_pence,
         SUM(earnings.amount_pence - FLOOR(earnings.amount_pence * $2 / 10000)) AS net_pence,
         a.stripe_connect_id
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
       JOIN accounts a ON a.id = earnings.writer_id
       WHERE a.stripe_connect_kyc_complete = TRUE
         AND a.stripe_connect_id IS NOT NULL
       GROUP BY earnings.writer_id, a.stripe_connect_id
       HAVING SUM(earnings.amount_pence - FLOOR(earnings.amount_pence * $2 / 10000)) >= $1`,
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
      const balanceRow = await client.query<{ net_pence: string }>(
        `SELECT COALESCE(SUM(amount_pence - FLOOR(amount_pence * $2 / 10000)), 0) AS net_pence
         FROM (
           SELECT amount_pence FROM read_events
           WHERE writer_id = $1 AND state = 'platform_settled' AND writer_payout_id IS NULL
           UNION ALL
           SELECT amount_pence FROM vote_charges
           WHERE recipient_id = $1 AND state = 'platform_settled' AND writer_payout_id IS NULL
         ) AS earnings`,
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
      await client.query(
        `UPDATE writer_payouts
         SET status = 'initiated', stripe_transfer_id = $1
         WHERE id = $2`,
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
    await pool.query(
      `UPDATE writer_payouts
       SET status = 'completed', completed_at = now()
       WHERE stripe_transfer_id = $1
         AND status != 'completed'`,
      [stripeTransferId]
    )

    logger.info({ stripeTransferId }, 'Writer payout confirmed')
  }

  // ---------------------------------------------------------------------------
  // handleFailedPayout — called from Stripe webhook on transfer.failed
  // Rolls reads back to platform_settled so they are retried on next cycle
  // ---------------------------------------------------------------------------

  async handleFailedPayout(stripeTransferId: string, reason: string): Promise<void> {
    await withTransaction(async (client) => {
      const payoutRow = await client.query<{ id: string; writer_id: string }>(
        `UPDATE writer_payouts
         SET status = 'failed', failed_reason = $1
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

      const platformFeePence = Math.floor(lockedGross * feeBps / 10000)
      let remainingPool = lockedGross - platformFeePence
      let flatFeesPaidPence = 0
      const splits: Array<{
        accountId: string; amountPence: number; shareType: string;
        shareBps: number | null; articleId: string | null;
      }> = []
      const flatFeeShareIds: string[] = []

      // --- Per-article overrides ---
      const { rows: articleShares } = await client.query<{
        id: string; article_id: string; account_id: string;
        share_type: string; share_value: number; paid_out: boolean;
      }>(
        `SELECT pas.id, pas.article_id, pas.account_id, pas.share_type, pas.share_value, pas.paid_out
         FROM publication_article_shares pas
         JOIN articles a ON a.id = pas.article_id
         WHERE pas.publication_id = $1`,
        [publicationId],
      )

      const articleIds = [...new Set(articleShares.map(s => s.article_id))]
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

      for (const share of articleShares) {
        if (share.share_type === 'flat_fee_pence' && !share.paid_out) {
          const fee = share.share_value
          if (fee > remainingPool) continue
          remainingPool -= fee
          flatFeesPaidPence += fee
          flatFeeShareIds.push(share.id)
          splits.push({
            accountId: share.account_id, amountPence: fee,
            shareType: 'flat_fee', shareBps: null,
            articleId: share.article_id,
          })
        } else if (share.share_type === 'revenue_bps') {
          const articleNet = articleEarnings.get(share.article_id) || 0
          const payout = Math.floor(articleNet * share.share_value / 10000)
          if (payout <= 0) continue
          remainingPool -= payout
          splits.push({
            accountId: share.account_id, amountPence: payout,
            shareType: 'article_revenue', shareBps: share.share_value,
            articleId: share.article_id,
          })
        }
      }

      // --- Standing shares ---
      const { rows: standingMembers } = await client.query<{
        account_id: string; revenue_share_bps: number;
      }>(
        `SELECT account_id, revenue_share_bps
         FROM publication_members
         WHERE publication_id = $1 AND removed_at IS NULL AND revenue_share_bps > 0`,
        [publicationId],
      )

      const totalStandingBps = standingMembers.reduce((sum, m) => sum + m.revenue_share_bps, 0)

      if (totalStandingBps > 0 && remainingPool > 0) {
        for (const member of standingMembers) {
          const payout = Math.floor(remainingPool * member.revenue_share_bps / totalStandingBps)
          if (payout <= 0) continue
          splits.push({
            accountId: member.account_id, amountPence: payout,
            shareType: 'standing', shareBps: member.revenue_share_bps,
            articleId: null,
          })
        }
      }

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

        await pool.query(
          `UPDATE publication_payout_splits
           SET status = 'initiated', stripe_transfer_id = $1
           WHERE id = $2`,
          [transfer.id, split.id],
        )
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
}

export const payoutService = new PayoutService()
