import Stripe from "stripe";
import type { PlatformConfig } from "../types/index.js";
import {
  pool,
  withTransaction,
  loadConfig,
} from "@platform-pub/shared/db/client.js";
import { recordLedger } from "@platform-pub/shared/lib/ledger.js";
import logger from "../lib/logger.js";

// =============================================================================
// SettlementService — Stage 2 of the three-stage money flow
//
// Two triggers per ADR §II.3:
//   • Threshold trigger: tab balance >= £8.00
//   • Monthly fallback: tab balance >= £2.00 AND >= 30 days since last read
//     (ADR: "one month after the last payment")
//
// Three-phase pattern (mirrors payout.ts):
//   1. Txn 1: Lock tab, INSERT tab_settlements as 'pending', COMMIT
//   2. Stripe paymentIntents.create OUTSIDE any transaction (stable idempotency key)
//   3. Txn 2: UPDATE tab_settlements with stripe_payment_intent_id, status='completed'
//
// Crash recovery: resumePendingSettlements() retries pending rows on startup.
// =============================================================================

const STRIPE_MIN_CHARGE_PENCE = 30;

class SettlementService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2023-10-16",
    });
  }

  // ---------------------------------------------------------------------------
  // checkAndSettle — run on every gate pass and on a scheduled job
  // Returns the settlement ID if settlement was initiated, null otherwise
  // ---------------------------------------------------------------------------

  async checkAndSettle(
    readerId: string,
    triggerType: "threshold" | "monthly_fallback" = "threshold",
  ): Promise<string | null> {
    const config = await loadConfig();

    const tabRow = await pool.query<{
      id: string;
      balance_pence: number;
      last_read_at: Date | null;
      last_settled_at: Date | null;
      stripe_customer_id: string | null;
    }>(
      `SELECT t.id, t.balance_pence, t.last_read_at, t.last_settled_at, a.stripe_customer_id
       FROM reading_tabs t
       JOIN accounts a ON a.id = t.reader_id
       WHERE t.reader_id = $1`,
      [readerId],
    );

    if (tabRow.rowCount === 0) return null;

    const tab = tabRow.rows[0];

    if (!tab.stripe_customer_id) {
      return null;
    }

    const shouldSettle = this.shouldTriggerSettlement(tab, config, triggerType);
    if (!shouldSettle) return null;

    return this.initiateSettlement(
      readerId,
      tab.id,
      tab.balance_pence,
      tab.stripe_customer_id,
      triggerType,
    );
  }

  // ---------------------------------------------------------------------------
  // shouldTriggerSettlement — pure logic, no DB
  // ---------------------------------------------------------------------------

  private shouldTriggerSettlement(
    tab: {
      balance_pence: number;
      last_read_at: Date | null;
      last_settled_at: Date | null;
    },
    config: PlatformConfig,
    triggerType: "threshold" | "monthly_fallback",
  ): boolean {
    if (triggerType === "threshold") {
      return tab.balance_pence >= config.tabSettlementThresholdPence;
    }

    if (tab.balance_pence < config.monthlyFallbackMinimumPence) return false;

    const now = Date.now();
    const fallbackMs = config.monthlyFallbackDays * 24 * 60 * 60 * 1000;
    const lastActivity = tab.last_read_at?.getTime() ?? 0;
    return now - lastActivity >= fallbackMs;
  }

  // ---------------------------------------------------------------------------
  // initiateSettlement — three-phase: reserve → Stripe → complete
  // ---------------------------------------------------------------------------

  private async initiateSettlement(
    readerId: string,
    tabId: string,
    amountPence: number,
    stripeCustomerId: string,
    triggerType: "threshold" | "monthly_fallback",
  ): Promise<string | null> {
    const reserved = await this.reserveSettlement(
      readerId,
      tabId,
      amountPence,
      stripeCustomerId,
      triggerType,
    );
    if (!reserved) return null;

    await this.completeSettlement(
      reserved.settlementId,
      reserved.amountPence,
      stripeCustomerId,
      readerId,
      tabId,
      triggerType,
    );
    return reserved.settlementId;
  }

  // ---------------------------------------------------------------------------
  // Phase 1: reserveSettlement (Txn 1)
  // Lock the tab, check for existing pending settlement, validate amount,
  // INSERT tab_settlements as 'pending'. Commits before any Stripe call.
  // ---------------------------------------------------------------------------

  private async reserveSettlement(
    readerId: string,
    tabId: string,
    expectedAmountPence: number,
    stripeCustomerId: string,
    triggerType: "threshold" | "monthly_fallback",
  ): Promise<{ settlementId: string; amountPence: number } | null> {
    const config = await loadConfig();

    return withTransaction(async (client) => {
      const lockedTab = await client.query<{ balance_pence: number }>(
        "SELECT balance_pence FROM reading_tabs WHERE id = $1 FOR UPDATE",
        [tabId],
      );

      const lockedBalance = lockedTab.rows[0].balance_pence;

      const actualAmount = Math.min(lockedBalance, expectedAmountPence);

      if (actualAmount < STRIPE_MIN_CHARGE_PENCE) {
        logger.info(
          {
            tabId,
            amountPence: actualAmount,
            minimum: STRIPE_MIN_CHARGE_PENCE,
          },
          "Amount below Stripe minimum — skipping settlement",
        );
        return null;
      }

      if (lockedBalance < expectedAmountPence) {
        logger.warn(
          { tabId, expected: expectedAmountPence, actual: lockedBalance },
          "Tab balance changed between check and lock — using locked amount",
        );
      }

      // Check for existing pending settlement on this tab
      const existingPending = await client.query<{ id: string }>(
        `SELECT id FROM tab_settlements WHERE tab_id = $1 AND status = 'pending'`,
        [tabId],
      );
      if (existingPending.rowCount! > 0) {
        logger.info(
          { tabId, existingSettlementId: existingPending.rows[0].id },
          "Pending settlement already exists — skipping",
        );
        return null;
      }

      const platformFeePence = Math.floor(
        (actualAmount * config.platformFeeBps) / 10_000,
      );
      const netToWritersPence = actualAmount - platformFeePence;

      const settlementRow = await client.query<{ id: string }>(
        `INSERT INTO tab_settlements (
           reader_id, tab_id, amount_pence, platform_fee_pence,
           net_to_writers_pence, trigger_type, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING id`,
        [
          readerId,
          tabId,
          actualAmount,
          platformFeePence,
          netToWritersPence,
          triggerType,
        ],
      );

      const settlementId = settlementRow.rows[0].id;

      logger.info(
        { settlementId, readerId, amountPence: actualAmount, triggerType },
        "Settlement reserved (pending Stripe charge)",
      );

      return { settlementId, amountPence: actualAmount };
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 2+3: completeSettlement
  // Stripe call with stable idempotency key, then Txn 2 to record PI ID and
  // flip status to 'completed'. Safe to retry — same key deduplicates on Stripe.
  // ---------------------------------------------------------------------------

  private async completeSettlement(
    settlementId: string,
    amountPence: number,
    stripeCustomerId: string,
    readerId: string,
    tabId: string,
    triggerType: "threshold" | "monthly_fallback",
  ): Promise<void> {
    const paymentIntent = await this.stripe.paymentIntents.create(
      {
        amount: amountPence,
        currency: "gbp",
        customer: stripeCustomerId,
        payment_method_types: ["card"],
        confirm: true,
        off_session: true,
        metadata: {
          platform: "all.haus",
          reader_id: readerId,
          tab_id: tabId,
          settlement_id: settlementId,
          trigger_type: triggerType,
        },
      },
      {
        idempotencyKey: `settlement-${settlementId}`,
      },
    );

    await pool.query(
      `UPDATE tab_settlements
       SET stripe_payment_intent_id = $1, status = 'completed'
       WHERE id = $2 AND status = 'pending'`,
      [paymentIntent.id, settlementId],
    );

    logger.info(
      {
        settlementId,
        readerId,
        amountPence,
        triggerType,
        paymentIntentId: paymentIntent.id,
      },
      "Settlement completed — awaiting Stripe confirmation",
    );
  }

  // ---------------------------------------------------------------------------
  // resumePendingSettlements — called at startup to retry any settlements that
  // were reserved but crashed before the Stripe call completed. Stable
  // idempotency keys make this safe to call repeatedly.
  // ---------------------------------------------------------------------------

  async resumePendingSettlements(): Promise<void> {
    const { rows } = await pool.query<{
      id: string;
      reader_id: string;
      tab_id: string;
      amount_pence: number;
      trigger_type: "threshold" | "monthly_fallback";
    }>(
      `SELECT id, reader_id, tab_id, amount_pence, trigger_type
       FROM tab_settlements
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    );

    if (rows.length === 0) return;

    logger.info({ count: rows.length }, "Resuming pending settlements");

    for (const row of rows) {
      try {
        // Look up the customer's stripe_customer_id
        const { rows: accRows } = await pool.query<{
          stripe_customer_id: string | null;
        }>(
          `SELECT a.stripe_customer_id
           FROM reading_tabs t
           JOIN accounts a ON a.id = t.reader_id
           WHERE t.id = $1`,
          [row.tab_id],
        );

        const stripeCustomerId = accRows[0]?.stripe_customer_id;
        if (!stripeCustomerId) {
          logger.warn(
            { settlementId: row.id, tabId: row.tab_id },
            "Cannot resume settlement — no stripe_customer_id found, marking failed",
          );
          await pool.query(
            `UPDATE tab_settlements SET status = 'failed' WHERE id = $1`,
            [row.id],
          );
          continue;
        }

        await this.completeSettlement(
          row.id,
          row.amount_pence,
          stripeCustomerId,
          row.reader_id,
          row.tab_id,
          row.trigger_type,
        );
      } catch (err) {
        logger.error(
          { err, settlementId: row.id, readerId: row.reader_id },
          "Failed to resume pending settlement — will retry next startup",
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // confirmSettlement — called from Stripe webhook on payment_intent.succeeded
  //
  // Subtracts the settled amount from the tab balance. Safe even if new reads
  // arrived between initiation and confirmation.
  // ---------------------------------------------------------------------------

  async confirmSettlement(
    paymentIntentId: string,
    stripeChargeId: string,
  ): Promise<void> {
    await withTransaction(async (client) => {
      const settlementRow = await client.query<{
        id: string;
        reader_id: string;
        tab_id: string;
        amount_pence: number;
        stripe_charge_id: string | null;
      }>(
        `SELECT id, reader_id, tab_id, amount_pence, stripe_charge_id
         FROM tab_settlements
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId],
      );

      if (settlementRow.rowCount === 0) {
        throw new Error(
          `No settlement found for PaymentIntent: ${paymentIntentId}`,
        );
      }

      const settlement = settlementRow.rows[0];

      if (settlement.stripe_charge_id !== null) {
        logger.warn(
          {
            settlementId: settlement.id,
            existingChargeId: settlement.stripe_charge_id,
            newChargeId: stripeChargeId,
          },
          "Settlement already confirmed — skipping duplicate webhook",
        );
        return;
      }

      const claimed = await client.query(
        `UPDATE tab_settlements SET stripe_charge_id = $1 WHERE id = $2 AND stripe_charge_id IS NULL`,
        [stripeChargeId, settlement.id],
      );
      if (claimed.rowCount === 0) {
        logger.warn(
          { settlementId: settlement.id, stripeChargeId },
          "Settlement claimed by concurrent webhook — skipping",
        );
        return;
      }

      await client.query(
        `UPDATE reading_tabs
         SET balance_pence = GREATEST(0, balance_pence - $1),
             last_settled_at = now(),
             updated_at = now()
         WHERE id = $2`,
        [settlement.amount_pence, settlement.tab_id],
      );

      // Ledger: reader credit — the Stripe charge pays the tab down by the
      // settled amount. Counterparty is the platform (NULL). This is the (+)
      // side that nets against the read_accrual / vote_charge / pledge_fulfil
      // debits so the reader's SUM tracks reading_tabs.balance_pence.
      await recordLedger(client, {
        accountId: settlement.reader_id,
        counterpartyId: null,
        amountPence: settlement.amount_pence,
        triggerType: "tab_settlement",
        refTable: "tab_settlements",
        refId: settlement.id,
      });

      const { rowCount } = await client.query(
        `UPDATE read_events
         SET state = 'platform_settled',
             tab_settlement_id = $1,
             state_updated_at = now()
         WHERE tab_id = $2
           AND state = 'accrued'
           AND read_at <= (SELECT settled_at FROM tab_settlements WHERE id = $1)`,
        [settlement.id, settlement.tab_id],
      );

      await client.query(
        `UPDATE vote_charges
         SET state = 'platform_settled'
         WHERE tab_id = $1
           AND state = 'accrued'
           AND created_at <= (SELECT settled_at FROM tab_settlements WHERE id = $2)`,
        [settlement.tab_id, settlement.id],
      );

      logger.info(
        {
          settlementId: settlement.id,
          readEventsUpdated: rowCount,
          stripeChargeId,
        },
        "Settlement confirmed — reads advanced to platform_settled",
      );
    });
  }

  // ---------------------------------------------------------------------------
  // handleFailedPayment — called from Stripe webhook on payment_intent.payment_failed
  //
  // Since tab balance is never modified at initiation, failure handling is
  // simple: mark the settlement as failed. Reads remain accrued.
  // ---------------------------------------------------------------------------

  async handleFailedPayment(
    paymentIntentId: string,
    failureMessage: string,
  ): Promise<void> {
    await withTransaction(async (client) => {
      const settlementRow = await client.query<{
        id: string;
        reader_id: string;
        tab_id: string;
        amount_pence: number;
      }>(
        `SELECT id, reader_id, tab_id, amount_pence
         FROM tab_settlements
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId],
      );

      if (settlementRow.rowCount === 0) return;

      const settlement = settlementRow.rows[0];

      await client.query(
        `UPDATE tab_settlements SET status = 'failed' WHERE id = $1`,
        [settlement.id],
      );

      logger.warn(
        { settlementId: settlement.id, paymentIntentId, failureMessage },
        "Payment failed — settlement marked failed, tab balance unchanged",
      );
    });
  }
}

export const settlementService = new SettlementService();
