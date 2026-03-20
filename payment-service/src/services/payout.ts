import Stripe from 'stripe'
import type { WriterEarnings, ArticleEarnings } from '../types/index.js'
import { pool, withTransaction, loadConfig } from '../db/client.js'
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
    const config = await loadConfig()

    // Find writers with enough platform_settled balance and completed KYC
    // FIX #4: Compute net amounts (after platform fee) for payout eligibility
    const { rows: eligibleWriters } = await pool.query<{
      writer_id: string
      gross_pence: string
      net_pence: string
      stripe_connect_id: string
    }>(
      `SELECT
         r.writer_id,
         SUM(r.amount_pence) AS gross_pence,
         SUM(r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)) AS net_pence,
         a.stripe_connect_id
       FROM read_events r
       JOIN accounts a ON a.id = r.writer_id
       WHERE r.state = 'platform_settled'
         AND r.writer_payout_id IS NULL
         AND a.stripe_connect_kyc_complete = TRUE
         AND a.stripe_connect_id IS NOT NULL
       GROUP BY r.writer_id, a.stripe_connect_id
       HAVING SUM(r.amount_pence - FLOOR(r.amount_pence * $2 / 10000)) >= $1`,
      [config.writerPayoutThresholdPence, config.platformFeeBps]
    )

    let processed = 0
    let totalPaidPence = 0

    for (const writer of eligibleWriters) {
      try {
        const netPence = parseInt(writer.net_pence, 10)
        await this.initiateWriterPayout(writer.writer_id, writer.stripe_connect_id, netPence)
        processed++
        totalPaidPence += netPence
      } catch (err) {
        logger.error({ err, writerId: writer.writer_id }, 'Payout failed for writer — continuing cycle')
      }
    }

    logger.info({ processed, totalPaidPence }, 'Payout cycle complete')
    return { processed, totalPaidPence }
  }

  // ---------------------------------------------------------------------------
  // initiateWriterPayout — single writer payout
  // ---------------------------------------------------------------------------

  private async initiateWriterPayout(
    writerId: string,
    stripeConnectId: string,
    amountPence: number
  ): Promise<string> {
    return withTransaction(async (client) => {
      // Lock writer to prevent concurrent payouts
      await client.query(
        'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
        [writerId]
      )

      // Re-check available balance inside the lock
      const config = await loadConfig()
      const balanceRow = await client.query<{ net_pence: string }>(
        `SELECT COALESCE(SUM(amount_pence - FLOOR(amount_pence * $2 / 10000)), 0) AS net_pence
         FROM read_events
         WHERE writer_id = $1
           AND state = 'platform_settled'
           AND writer_payout_id IS NULL`,
        [writerId, config.platformFeeBps]
      )

      const lockedAmountPence = parseInt(balanceRow.rows[0].net_pence, 10)

      if (lockedAmountPence !== amountPence) {
        // Balance changed between query and lock — use locked amount
        logger.warn(
          { writerId, expected: amountPence, actual: lockedAmountPence },
          'Balance changed between eligibility check and lock — using locked amount'
        )
      }

      // Create Stripe Connect transfer (net amount — platform fee already deducted)
      const transfer = await this.stripe.transfers.create({
        amount: lockedAmountPence,
        currency: 'gbp',
        destination: stripeConnectId,
        metadata: {
          platform: 'platform.pub',
          writer_id: writerId,
        },
      })

      // Write payout record
      const payoutRow = await client.query<{ id: string }>(
        `INSERT INTO writer_payouts (
           writer_id, amount_pence, stripe_transfer_id, stripe_connect_id, status
         ) VALUES ($1, $2, $3, $4, 'initiated')
         RETURNING id`,
        [writerId, lockedAmountPence, transfer.id, stripeConnectId]
      )

      const payoutId = payoutRow.rows[0].id

      // Link read_events to payout and advance state to writer_paid
      await client.query(
        `UPDATE read_events
         SET state = 'writer_paid',
             writer_payout_id = $1,
             state_updated_at = now()
         WHERE writer_id = $2
           AND state = 'platform_settled'
           AND writer_payout_id IS NULL`,
        [payoutId, writerId]
      )

      logger.info(
        { payoutId, writerId, amountPence: lockedAmountPence, stripeTransferId: transfer.id },
        'Writer payout initiated'
      )

      return payoutId
    })
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
       WHERE stripe_transfer_id = $1`,
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

      logger.warn({ payoutId, writerId, stripeTransferId, reason }, 'Writer payout failed — reads rolled back')
    })
  }
}

export const payoutService = new PayoutService()
