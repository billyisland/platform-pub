import { randomUUID } from 'node:crypto'
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

      // Re-check available balance inside the lock (reads + upvote charges)
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
      // Idempotency key protects against duplicate transfers on network retries
      const transfer = await this.stripe.transfers.create({
        amount: lockedAmountPence,
        currency: 'gbp',
        destination: stripeConnectId,
        metadata: {
          platform: 'all.haus',
          writer_id: writerId,
        },
      }, {
        idempotencyKey: `payout-${writerId}-${randomUUID()}`,
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

      // Link vote_charges (upvotes) to payout and advance state to writer_paid
      await client.query(
        `UPDATE vote_charges
         SET state = 'writer_paid',
             writer_payout_id = $1
         WHERE recipient_id = $2
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
          config.platformFeeBps
        )
        processed++
        totalPaidPence += paidPence
      } catch (err) {
        logger.error({ err, publicationId: pub.publication_id }, 'Publication payout failed — continuing cycle')
      }
    }

    logger.info({ processed, totalPaidPence }, 'Publication payout cycle complete')
    return { processed, totalPaidPence }
  }

  private async initiatePublicationPayout(
    publicationId: string,
    grossPence: number,
    feeBps: number
  ): Promise<number> {
    return withTransaction(async (client) => {
      // Lock the publication to prevent concurrent payouts
      await client.query(
        'SELECT id FROM publications WHERE id = $1 FOR UPDATE',
        [publicationId]
      )

      // Re-check gross inside lock
      const { rows: [balRow] } = await client.query<{ gross_pence: string }>(
        `SELECT COALESCE(SUM(r.amount_pence), 0) AS gross_pence
         FROM read_events r
         JOIN articles a ON a.id = r.article_id
         WHERE a.publication_id = $1
           AND r.state = 'platform_settled'
           AND r.writer_payout_id IS NULL`,
        [publicationId]
      )

      const lockedGross = parseInt(balRow.gross_pence, 10)
      const platformFeePence = Math.floor(lockedGross * feeBps / 10000)
      let remainingPool = lockedGross - platformFeePence
      let flatFeesPaidPence = 0
      const splits: Array<{
        accountId: string; amountPence: number; shareType: string;
        shareBps: number | null; articleId: string | null; stripeTransferId: string | null;
      }> = []

      // --- Step 1: Per-article overrides ---
      // Get all article-level shares for this publication's unsettled articles
      const { rows: articleShares } = await client.query<{
        id: string; article_id: string; account_id: string;
        share_type: string; share_value: number; paid_out: boolean;
      }>(
        `SELECT pas.id, pas.article_id, pas.account_id, pas.share_type, pas.share_value, pas.paid_out
         FROM publication_article_shares pas
         JOIN articles a ON a.id = pas.article_id
         WHERE pas.publication_id = $1`,
        [publicationId]
      )

      // Compute per-article net earnings for articles that have overrides
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
          [articleIds, feeBps]
        )
        for (const r of artRows) {
          articleEarnings.set(r.article_id, parseInt(r.net_pence, 10))
        }
      }

      for (const share of articleShares) {
        if (share.share_type === 'flat_fee_pence' && !share.paid_out) {
          // Flat fee: deduct from pool, pay contributor
          const fee = share.share_value
          if (fee > remainingPool) continue // not enough in pool
          remainingPool -= fee
          flatFeesPaidPence += fee
          splits.push({
            accountId: share.account_id, amountPence: fee,
            shareType: 'flat_fee', shareBps: null,
            articleId: share.article_id, stripeTransferId: null,
          })
          // Mark as paid
          await client.query(
            `UPDATE publication_article_shares SET paid_out = TRUE WHERE id = $1`,
            [share.id]
          )
        } else if (share.share_type === 'revenue_bps') {
          // Revenue share on this specific article
          const articleNet = articleEarnings.get(share.article_id) || 0
          const payout = Math.floor(articleNet * share.share_value / 10000)
          if (payout <= 0) continue
          remainingPool -= payout
          splits.push({
            accountId: share.account_id, amountPence: payout,
            shareType: 'article_revenue', shareBps: share.share_value,
            articleId: share.article_id, stripeTransferId: null,
          })
        }
      }

      // --- Step 2: Standing shares ---
      const { rows: standingMembers } = await client.query<{
        account_id: string; revenue_share_bps: number;
      }>(
        `SELECT account_id, revenue_share_bps
         FROM publication_members
         WHERE publication_id = $1 AND removed_at IS NULL AND revenue_share_bps > 0`,
        [publicationId]
      )

      const totalStandingBps = standingMembers.reduce((sum, m) => sum + m.revenue_share_bps, 0)

      if (totalStandingBps > 0 && remainingPool > 0) {
        for (const member of standingMembers) {
          const payout = Math.floor(remainingPool * member.revenue_share_bps / totalStandingBps)
          if (payout <= 0) continue
          splits.push({
            accountId: member.account_id, amountPence: payout,
            shareType: 'standing', shareBps: member.revenue_share_bps,
            articleId: null, stripeTransferId: null,
          })
        }
      }

      // --- Step 3: Create publication_payouts record ---
      const { rows: [payoutRow] } = await client.query<{ id: string }>(
        `INSERT INTO publication_payouts
           (publication_id, total_pool_pence, platform_fee_pence, flat_fees_paid_pence, remaining_pool_pence, status)
         VALUES ($1, $2, $3, $4, $5, 'initiated')
         RETURNING id`,
        [publicationId, lockedGross, platformFeePence, flatFeesPaidPence, remainingPool]
      )
      const payoutId = payoutRow.id

      // --- Step 4: Stripe transfers + record splits ---
      let totalTransferred = 0

      for (const split of splits) {
        if (split.amountPence <= 0) continue

        // Look up member's Stripe Connect account
        const { rows: accRows } = await client.query<{
          stripe_connect_id: string | null; stripe_connect_kyc_complete: boolean;
        }>(
          `SELECT stripe_connect_id, stripe_connect_kyc_complete FROM accounts WHERE id = $1`,
          [split.accountId]
        )

        const acc = accRows[0]
        let splitStatus: string = 'pending'
        let stripeTransferId: string | null = null

        if (acc?.stripe_connect_id && acc.stripe_connect_kyc_complete) {
          try {
            const transfer = await this.stripe.transfers.create({
              amount: split.amountPence,
              currency: 'gbp',
              destination: acc.stripe_connect_id,
              metadata: {
                platform: 'all.haus',
                publication_payout_id: payoutId,
                account_id: split.accountId,
              },
            }, {
              idempotencyKey: `pub-split-${payoutId}-${split.accountId}-${randomUUID()}`,
            })
            stripeTransferId = transfer.id
            splitStatus = 'initiated'
            totalTransferred += split.amountPence
          } catch (err) {
            logger.error({ err, accountId: split.accountId, payoutId }, 'Stripe transfer failed for publication split')
            splitStatus = 'failed'
          }
        }
        // else: pending until KYC completes

        await client.query(
          `INSERT INTO publication_payout_splits
             (publication_payout_id, account_id, share_bps, amount_pence, share_type, article_id, stripe_transfer_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::payout_status)`,
          [payoutId, split.accountId, split.shareBps, split.amountPence,
           split.shareType, split.articleId, stripeTransferId, splitStatus]
        )
      }

      // --- Step 5: Mark read_events as writer_paid ---
      await client.query(
        `UPDATE read_events
         SET state = 'writer_paid',
             writer_payout_id = $1,
             state_updated_at = now()
         FROM articles a
         WHERE read_events.article_id = a.id
           AND a.publication_id = $2
           AND read_events.state = 'platform_settled'
           AND read_events.writer_payout_id IS NULL`,
        [payoutId, publicationId]
      )

      // Mark payout as completed if all splits succeeded
      const allInitiated = splits.every(s => s.amountPence <= 0) ||
        splits.filter(s => s.amountPence > 0).length === 0
      if (!allInitiated) {
        await client.query(
          `UPDATE publication_payouts SET status = 'initiated' WHERE id = $1`,
          [payoutId]
        )
      }

      logger.info(
        { payoutId, publicationId, grossPence: lockedGross, platformFeePence, totalTransferred, splits: splits.length },
        'Publication payout initiated'
      )

      return totalTransferred
    })
  }
}

export const payoutService = new PayoutService()
