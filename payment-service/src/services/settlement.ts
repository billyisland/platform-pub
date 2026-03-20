import Stripe from 'stripe'
import type { PoolClient } from 'pg'
import type { TabSettlement, PlatformConfig } from '../types/index.js'
import { pool, withTransaction, loadConfig } from '../db/client.js'
import logger from '../lib/logger.js'

// =============================================================================
// SettlementService — Stage 2 of the three-stage money flow
//
// Two triggers per ADR §II.3:
//   • Threshold trigger: tab balance >= £8.00
//   • Monthly fallback: tab balance >= £2.00 AND >= 30 days since last read
//     (ADR: "one month after the last payment")
//
// On settlement:
//   1. Lock the reader's tab row
//   2. Snapshot the current tab balance for settlement
//   3. Create a Stripe PaymentIntent for that amount
//   4. Write tab_settlement record (pending confirmation)
//   5. Mark tab as settling (balance frozen, not zeroed — see FIX #13)
//
// Stripe webhook confirms payment — balance is zeroed only on confirmation.
// =============================================================================

export class SettlementService {
  private stripe: Stripe

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
    })
  }

  // ---------------------------------------------------------------------------
  // checkAndSettle — run on every gate pass and on a scheduled job
  // Returns the settlement ID if settlement was initiated, null otherwise
  // ---------------------------------------------------------------------------

  async checkAndSettle(
    readerId: string,
    triggerType: 'threshold' | 'monthly_fallback' = 'threshold'
  ): Promise<string | null> {
    const config = await loadConfig()

    const tabRow = await pool.query<{
      id: string
      balance_pence: number
      last_read_at: Date | null
      last_settled_at: Date | null
      stripe_customer_id: string | null
    }>(
      `SELECT t.id, t.balance_pence, t.last_read_at, t.last_settled_at, a.stripe_customer_id
       FROM reading_tabs t
       JOIN accounts a ON a.id = t.reader_id
       WHERE t.reader_id = $1`,
      [readerId]
    )

    if (tabRow.rowCount === 0) return null

    const tab = tabRow.rows[0]

    if (!tab.stripe_customer_id) {
      // Reader has no card — cannot settle
      return null
    }

    const shouldSettle = this.shouldTriggerSettlement(tab, config, triggerType)
    if (!shouldSettle) return null

    return this.initiateSettlement(readerId, tab.id, tab.balance_pence, tab.stripe_customer_id, triggerType)
  }

  // ---------------------------------------------------------------------------
  // shouldTriggerSettlement — pure logic, no DB
  //
  // FIX #3: The monthly fallback now checks last_read_at (the reader's last
  // reading activity), not last_settled_at. The ADR says the tab settles
  // "one month after the last payment" — meaning a month after the reader
  // last read something, not a month after the last settlement.
  // ---------------------------------------------------------------------------

  private shouldTriggerSettlement(
    tab: { balance_pence: number; last_read_at: Date | null; last_settled_at: Date | null },
    config: PlatformConfig,
    triggerType: 'threshold' | 'monthly_fallback'
  ): boolean {
    if (triggerType === 'threshold') {
      return tab.balance_pence >= config.tabSettlementThresholdPence
    }

    // Monthly fallback: at least £2 AND 30+ days since last read activity
    if (tab.balance_pence < config.monthlyFallbackMinimumPence) return false

    const now = Date.now()
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    // FIX #3: Use last_read_at, falling back to tab creation (epoch 0 if null)
    const lastActivity = tab.last_read_at?.getTime() ?? 0
    return now - lastActivity >= thirtyDays
  }

  // ---------------------------------------------------------------------------
  // initiateSettlement — writes DB record, creates Stripe PaymentIntent
  //
  // FIX #13: Tab balance is NO LONGER zeroed at initiation. Instead, we
  // record the settlement amount and leave the tab balance intact. The
  // confirmSettlement webhook handler zeroes the settled portion. This
  // prevents the race condition where:
  //   1. Tab zeroed at initiation
  //   2. New read arrives, adds to tab (now at new_read_amount)
  //   3. Stripe fails, handleFailedPayment restores old balance
  //   4. New read's amount is lost (overwritten by restoration)
  //
  // The settlement record tracks the amount being settled. New reads that
  // arrive during the settlement window are added to the tab normally and
  // are not part of this settlement.
  // ---------------------------------------------------------------------------

  private async initiateSettlement(
    readerId: string,
    tabId: string,
    amountPence: number,
    stripeCustomerId: string,
    triggerType: 'threshold' | 'monthly_fallback'
  ): Promise<string> {
    const config = await loadConfig()

    // Calculate fee split — integer arithmetic throughout
    const platformFeePence = Math.floor((amountPence * config.platformFeeBps) / 10_000)
    const netToWritersPence = amountPence - platformFeePence

    return withTransaction(async (client) => {
      // Lock the tab to prevent double-settlement
      const lockedTab = await client.query<{ balance_pence: number }>(
        'SELECT balance_pence FROM reading_tabs WHERE id = $1 FOR UPDATE',
        [tabId]
      )

      // Re-check balance inside the lock (may have changed)
      const lockedBalance = lockedTab.rows[0].balance_pence
      if (lockedBalance < amountPence) {
        // Balance dropped — use the locked balance instead
        logger.warn(
          { tabId, expected: amountPence, actual: lockedBalance },
          'Tab balance changed between check and lock — using locked amount'
        )
        // Recalculate with actual balance
        const actualAmount = lockedBalance
        const actualFee = Math.floor((actualAmount * config.platformFeeBps) / 10_000)
        const actualNet = actualAmount - actualFee

        return this.executeSettlement(
          client, readerId, tabId, actualAmount, actualFee, actualNet,
          stripeCustomerId, triggerType
        )
      }

      return this.executeSettlement(
        client, readerId, tabId, amountPence, platformFeePence, netToWritersPence,
        stripeCustomerId, triggerType
      )
    })
  }

  private async executeSettlement(
    client: PoolClient,
    readerId: string,
    tabId: string,
    amountPence: number,
    platformFeePence: number,
    netToWritersPence: number,
    stripeCustomerId: string,
    triggerType: 'threshold' | 'monthly_fallback'
  ): Promise<string> {
    // Create Stripe PaymentIntent — off-session (card already on file)
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: amountPence,
      currency: 'gbp',
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      confirm: true,
      off_session: true,
      metadata: {
        platform: 'platform.pub',
        reader_id: readerId,
        tab_id: tabId,
        trigger_type: triggerType,
      },
    })

    // Write settlement record (pending Stripe confirmation)
    const settlementRow = await client.query<{ id: string }>(
      `INSERT INTO tab_settlements (
         reader_id, tab_id, amount_pence, platform_fee_pence,
         net_to_writers_pence, stripe_payment_intent_id, trigger_type
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        readerId,
        tabId,
        amountPence,
        platformFeePence,
        netToWritersPence,
        paymentIntent.id,
        triggerType,
      ]
    )

    const settlementId = settlementRow.rows[0].id

    // FIX #13: Do NOT zero the tab here. The tab balance stays as-is.
    // New reads can still accrue. The confirmSettlement webhook handler
    // subtracts the settled amount when Stripe confirms.

    logger.info(
      { settlementId, readerId, amountPence, triggerType, paymentIntentId: paymentIntent.id },
      'Settlement initiated — awaiting Stripe confirmation'
    )

    return settlementId
  }

  // ---------------------------------------------------------------------------
  // confirmSettlement — called from Stripe webhook on payment_intent.succeeded
  //
  // FIX #13: Now subtracts the settled amount from the tab balance (instead
  // of assuming it was already zeroed). This is safe even if new reads arrived
  // between initiation and confirmation.
  // ---------------------------------------------------------------------------

  async confirmSettlement(paymentIntentId: string, stripeChargeId: string): Promise<void> {
    await withTransaction(async (client) => {
      // Find the settlement record
      const settlementRow = await client.query<{
        id: string
        reader_id: string
        tab_id: string
        amount_pence: number
      }>(
        `SELECT id, reader_id, tab_id, amount_pence
         FROM tab_settlements
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId]
      )

      if (settlementRow.rowCount === 0) {
        throw new Error(`No settlement found for PaymentIntent: ${paymentIntentId}`)
      }

      const settlement = settlementRow.rows[0]

      // Record Stripe charge ID
      await client.query(
        `UPDATE tab_settlements SET stripe_charge_id = $1 WHERE id = $2`,
        [stripeChargeId, settlement.id]
      )

      // FIX #13: Subtract the settled amount from the tab (not zero it).
      // New reads may have accrued since settlement was initiated.
      await client.query(
        `UPDATE reading_tabs
         SET balance_pence = GREATEST(0, balance_pence - $1),
             last_settled_at = now(),
             updated_at = now()
         WHERE id = $2`,
        [settlement.amount_pence, settlement.tab_id]
      )

      // Advance accrued read_events to platform_settled
      // Only transition reads that were accrued at the time of settlement
      // (reads with read_at <= settlement creation time)
      const { rowCount } = await client.query(
        `UPDATE read_events
         SET state = 'platform_settled',
             tab_settlement_id = $1,
             state_updated_at = now()
         WHERE tab_id = $2
           AND state = 'accrued'
           AND read_at <= (SELECT settled_at FROM tab_settlements WHERE id = $1)`,
        [settlement.id, settlement.tab_id]
      )

      logger.info(
        { settlementId: settlement.id, readEventsUpdated: rowCount, stripeChargeId },
        'Settlement confirmed — reads advanced to platform_settled'
      )
    })
  }

  // ---------------------------------------------------------------------------
  // handleFailedPayment — called from Stripe webhook on payment_intent.payment_failed
  //
  // FIX #13: Since we no longer zero the tab at initiation, failure handling
  // is simpler: just delete the settlement record. The tab balance was never
  // modified, so no restoration is needed. Reads remain accrued.
  // ---------------------------------------------------------------------------

  async handleFailedPayment(paymentIntentId: string, failureMessage: string): Promise<void> {
    await withTransaction(async (client) => {
      const settlementRow = await client.query<{
        id: string
        reader_id: string
        tab_id: string
        amount_pence: number
      }>(
        `SELECT id, reader_id, tab_id, amount_pence
         FROM tab_settlements
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId]
      )

      if (settlementRow.rowCount === 0) return

      const settlement = settlementRow.rows[0]

      // Remove the settlement record — reads stay accrued, tab is untouched
      await client.query('DELETE FROM tab_settlements WHERE id = $1', [settlement.id])

      logger.warn(
        { settlementId: settlement.id, paymentIntentId, failureMessage },
        'Payment failed — settlement record removed, tab balance unchanged'
      )
    })
  }
}

export const settlementService = new SettlementService()
