import Stripe from "stripe";
import type { PlatformConfig } from "../types/index.js";
import {
  pool,
  withTransaction,
  loadConfig,
} from "@platform-pub/shared/db/client.js";
import { recordLedger } from "@platform-pub/shared/lib/ledger.js";
import { tributesEnabled } from "@platform-pub/shared/lib/env.js";
import { readNetSql } from "@platform-pub/shared/lib/per-read-net.js";
import { isTerminalChargeError } from "../lib/charge-errors.js";
import {
  computeChargebackReversal,
  type ReversalRead,
  type ReversalVote,
  type ReversalAccrual,
} from "./chargeback.js";
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
      card_action_required_at: Date | null;
    }>(
      `SELECT t.id, t.balance_pence, t.last_read_at, t.last_settled_at,
              a.stripe_customer_id, a.card_action_required_at
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

    // Settlement back-off: a prior terminal decline flagged the account
    // (completeSettlement). Skip until the reader re-attaches a card
    // (connectPaymentMethod clears the flag) so we re-attempt once per
    // card-attach, not on every read against a known-bad card.
    if (tab.card_action_required_at) {
      logger.info(
        { readerId, since: tab.card_action_required_at },
        "Card action required — settlement backed off until card re-attached",
      );
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
    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await this.stripe.paymentIntents.create(
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
    } catch (err) {
      // Terminal decline / SCA / unusable card: mark the settlement 'failed' so
      // the reserveSettlement pending-guard releases and the tab unfreezes, and
      // flag the account so settlement backs off until the reader re-attaches a
      // card. Without this the row stays 'pending' forever (STRIPE audit S1, P0).
      if (isTerminalChargeError(err)) {
        const piId =
          (err as { payment_intent?: { id?: string } }).payment_intent?.id ??
          (err as { raw?: { payment_intent?: { id?: string } } }).raw
            ?.payment_intent?.id ??
          null;
        const code =
          (err as { code?: string }).code ??
          (err as { type?: string }).type ??
          "charge_failed";
        await withTransaction(async (client) => {
          // COALESCE keeps any PI id Stripe minted (it does for a confirmed-then-
          // declined PI) so payment_intent.payment_failed matches handleFailedPayment.
          await client.query(
            `UPDATE tab_settlements
             SET status = 'failed',
                 stripe_payment_intent_id = COALESCE($1, stripe_payment_intent_id),
                 failure_reason = $2
             WHERE id = $3 AND status = 'pending'`,
            [piId, code, settlementId],
          );
          await client.query(
            `UPDATE accounts
             SET card_action_required_at = now(), updated_at = now()
             WHERE id = $1`,
            [readerId],
          );
        });
        logger.warn(
          { settlementId, readerId, code, paymentIntentId: piId },
          "Settlement charge declined — settlement marked failed, tab unfrozen, card-action flagged",
        );
        return;
      }
      // Transient (network / 5xx / rate-limit): leave the row 'pending' and
      // re-throw. resumePendingSettlements retries with the stable idempotency
      // key; the charge may have succeeded, so we must NOT mark it failed.
      throw err;
    }

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
        status: string;
      }>(
        `SELECT id, reader_id, tab_id, amount_pence, stripe_charge_id, status
         FROM tab_settlements
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId],
      );

      if (settlementRow.rowCount === 0) {
        // An unknown PaymentIntent is not one of our settlements (a manual
        // dashboard charge, a test-mode event, a future non-settlement PI).
        // Do NOT throw: a throw bubbles to the webhook's 500 path, which leaves
        // stripe_webhook_events.processed_at NULL, so Stripe redelivers the same
        // event for days, each retry re-throwing — a poison event. Log and
        // return, matching the no-match handling in reverseSettlement and
        // handleFailedPayment.
        logger.warn(
          { paymentIntentId, stripeChargeId },
          "confirmSettlement: no settlement for PaymentIntent — ignoring (not a tab-settlement charge?)",
        );
        return;
      }

      const settlement = settlementRow.rows[0];

      // A settlement we marked 'failed' (terminal off-session decline) may carry
      // a stored PI id. If that PI somehow later succeeds, do NOT advance the
      // tab — the decline already flagged the account and left reads accrued.
      if (settlement.status === "failed") {
        logger.warn(
          { settlementId: settlement.id, paymentIntentId },
          "confirmSettlement: settlement is 'failed' — not advancing (stray success for a declined off-session PI?)",
        );
        return;
      }

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

      // No GREATEST(0, …) clamp: the column and the ledger must move by the
      // SAME signed delta (migration 124 dropped the >= 0 CHECK). The settle
      // amount was clamped to the locked balance at reservation
      // (reserveSettlement: actualAmount = min(lockedBalance, expected)), so an
      // over-settlement only arises if the balance dropped between reserve and
      // confirm (e.g. an interleaved subscription credit-back). A clamp here
      // would floor the column at 0 while the unclamped ledger entry below
      // credits the full amount → −SUM(ledger) ≠ balance_pence permanently
      // (the Phase-3 "agree to the penny" guarantee). Letting it go negative is
      // correct: negative = platform owes the reader / pre-paid credit.
      await client.query(
        `UPDATE reading_tabs
         SET balance_pence = balance_pence - $1,
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

      // Ledger: writer-side accrual — each read just advanced to platform_settled
      // EARNS its writer the post-fee net (item 3 final phase). The earned-side
      // mirror of the reader's read_accrual debit (account=writer, cp=reader); the
      // gross−net gap is the implicit platform fee. We post the FULL read_net here,
      // tribute-blind: the held carve stays out of the ledger (guard #7) and only
      // a PAID root carve later debits the author (tribute_carve, in
      // completeTributePayout). So ledger_writer_earned == read_net − paid_root_carve
      // == getWriterEarnings.earningsTotal + reservedPence. One entry per read,
      // ref = the read, so the cutover reconciles read-for-read.
      const config = await loadConfig();
      const { rows: settledReads } = await client.query<{
        id: string;
        writer_id: string;
        net_pence: string;
      }>(
        `SELECT id, writer_id, ${readNetSql("amount_pence", "$2")} AS net_pence
         FROM read_events
         WHERE tab_settlement_id = $1 AND state = 'platform_settled'`,
        [settlement.id, config.platformFeeBps],
      );
      for (const r of settledReads) {
        const net = parseInt(r.net_pence, 10);
        if (net === 0) continue;
        await recordLedger(client, {
          accountId: r.writer_id,
          counterpartyId: settlement.reader_id,
          amountPence: net,
          triggerType: "writer_accrual",
          refTable: "read_events",
          refId: r.id,
        });
      }

      await client.query(
        `UPDATE vote_charges
         SET state = 'platform_settled',
             tab_settlement_id = $2
         WHERE tab_id = $1
           AND state = 'accrued'
           AND created_at <= (SELECT settled_at FROM tab_settlements WHERE id = $2)`,
        [settlement.tab_id, settlement.id],
      );

      // Tribute apportionment (Upstream Edges Phase 3 + Phase-5 chains, dark
      // behind TRIBUTES_ENABLED). For each read just advanced to platform_settled
      // on a tributed (proposed|live) article, freeze one tribute_accruals row
      // per NODE of the tribute tree: that node's GROSS inflow for THIS read =
      // read_net × (∏ bps along the node's path) ÷ 10000^pathlen, computed with
      // the fee bps of the moment and never recomputed. Each carving party
      // (author at depth 0, every inspirer below) subtracts its DIRECT children's
      // gross at payout — conservation telescopes to author + Σ(every node's
      // retained) == read_net (no clamp; each node keeps its children's floor
      // dust). A node accrues straight to 'released' when its OWN tribute is
      // already 'live' (no held→released flip is coming for reads that settle
      // after that node consented), else 'held'.
      //
      // The path product is carried as NUMERIC down a WITH RECURSIVE walk so it
      // can't overflow bigint at depth (10000^8), and FLOORed once per (node,
      // read) — the shipped per-row-then-floor rule applied per node. Bounded by
      // the depth cap (migration 128). A node whose gross floors to 0 is dropped
      // (its descendants are ≤ it, so they drop too).
      //
      // ON CONFLICT DO NOTHING makes this idempotent against a duplicate webhook
      // (the (tribute_id, read_event_id) unique); confirmSettlement is already
      // guarded by the stripe_charge_id claim above, so this is belt-and-braces.
      // Accruals live OUTSIDE ledger_entries until they reach a real account
      // (build-plan guard #7), so this writes no ledger row.
      if (tributesEnabled()) {
        await client.query(
          `WITH RECURSIVE settled_reads AS (
             SELECT re.id AS read_event_id,
                    re.article_id,
                    ${readNetSql("re.amount_pence", "$2")}::numeric AS read_net
             FROM read_events re
             WHERE re.tab_settlement_id = $1
               AND re.state = 'platform_settled'
           ),
           tree AS (
             -- Roots (depth 0): source-of-funds is the piece net; path factor = bps/10000.
             SELECT t.id AS tribute_id, t.status, sr.read_event_id,
                    sr.read_net,
                    (t.percentage_bps::numeric / 10000) AS path_factor
             FROM tributes t
             JOIN settled_reads sr ON sr.article_id = t.article_id
             WHERE t.parent_tribute_id IS NULL
               AND t.status IN ('proposed', 'live')
               AND t.deleted_at IS NULL
             UNION ALL
             -- Children: source-of-funds is the parent's share; multiply the factor.
             SELECT c.id, c.status, parent.read_event_id,
                    parent.read_net,
                    parent.path_factor * (c.percentage_bps::numeric / 10000)
             FROM tree parent
             JOIN tributes c
               ON c.parent_tribute_id = parent.tribute_id
              AND c.status IN ('proposed', 'live')
              AND c.deleted_at IS NULL
           )
           INSERT INTO tribute_accruals (tribute_id, read_event_id, amount_pence, state)
           SELECT tribute_id, read_event_id,
                  FLOOR(read_net * path_factor)::bigint,
                  CASE WHEN status = 'live' THEN 'released' ELSE 'held' END
           FROM tree
           WHERE FLOOR(read_net * path_factor) > 0
           ON CONFLICT (tribute_id, read_event_id) DO NOTHING`,
          [settlement.id, config.platformFeeBps],
        );
      }

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

  // ---------------------------------------------------------------------------
  // reverseSettlement — F3 reader chargeback / refund unwind.
  //
  // Called from the Stripe webhook on charge.dispute.closed (status=lost) and
  // charge.refunded, keyed by the disputed/refunded Stripe charge id (==
  // tab_settlements.stripe_charge_id). One transaction:
  //   1. Find the settlement; idempotently claim reversed_at (no-op if already
  //      reversed — guards duplicate webhooks and a refund-then-dispute-lost on
  //      the same charge).
  //   2. Restore the reader's debt (balance_pence += amount) + a reversing
  //      tab_settlement_reversal ledger entry.
  //   3. Load the reads / vote_charges / tribute accruals tied to this charge and
  //      hand them to the pure planner (chargeback.ts). Apply its plan: post the
  //      writer/tribute reversal entries, flip rolled-back reads + votes to
  //      'charged_back', void the unpaid accruals.
  //
  // No tributesEnabled() gate: the plan is data-driven (zero accruals ⇒ the
  // platform-wide case), so it stays correct across a flag toggled on then off.
  // ---------------------------------------------------------------------------

  async reverseSettlement(
    stripeChargeId: string,
    reason: string,
  ): Promise<void> {
    await withTransaction(async (client) => {
      const settlementRow = await client.query<{
        id: string;
        reader_id: string;
        tab_id: string;
        amount_pence: number;
        reversed_at: Date | null;
      }>(
        `SELECT id, reader_id, tab_id, amount_pence, reversed_at
         FROM tab_settlements
         WHERE stripe_charge_id = $1`,
        [stripeChargeId],
      );

      if (settlementRow.rowCount === 0) {
        logger.warn(
          { stripeChargeId, reason },
          "reverseSettlement: no settlement for charge — ignoring (not a tab-settlement charge?)",
        );
        return;
      }

      const settlement = settlementRow.rows[0];

      if (settlement.reversed_at !== null) {
        logger.info(
          { settlementId: settlement.id, stripeChargeId },
          "Settlement already reversed — skipping duplicate",
        );
        return;
      }

      // Lock the tab so the restore races neither a settlement nor an accrual.
      await client.query(
        "SELECT balance_pence FROM reading_tabs WHERE id = $1 FOR UPDATE",
        [settlement.tab_id],
      );

      // Claim the reversal idempotently — only the first txn to flip
      // reversed_at proceeds (a concurrent duplicate gets rowCount 0).
      const claimed = await client.query(
        `UPDATE tab_settlements
         SET reversed_at = now(), reversal_reason = $2
         WHERE id = $1 AND reversed_at IS NULL`,
        [settlement.id, reason],
      );
      if (claimed.rowCount === 0) {
        logger.info(
          { settlementId: settlement.id },
          "Settlement reversal claimed by concurrent webhook — skipping",
        );
        return;
      }

      const config = await loadConfig();

      const { rows: reads } = await client.query<{
        id: string;
        amount_pence: number;
        state: string;
        writer_id: string;
      }>(
        `SELECT id, amount_pence, state, writer_id
         FROM read_events
         WHERE tab_settlement_id = $1
           AND state IN ('platform_settled', 'writer_paid')`,
        [settlement.id],
      );

      const { rows: votes } = await client.query<{
        id: string;
        amount_pence: number;
        state: string;
        recipient_id: string | null;
      }>(
        `SELECT id, amount_pence, state, recipient_id
         FROM vote_charges
         WHERE tab_settlement_id = $1
           AND state IN ('platform_settled', 'writer_paid')`,
        [settlement.id],
      );

      // Every non-voided accrual on the reads this charge settled, with the
      // tribute (and its parent) so the planner can attribute net per node.
      const { rows: accrualRows } = await client.query<{
        id: string;
        read_event_id: string;
        tribute_id: string;
        parent_tribute_id: string | null;
        amount_pence: number;
        state: string;
        resolved_account_id: string;
        author_account_id: string;
        parent_resolved_account_id: string | null;
        parent_author_account_id: string | null;
        swept_return_kind: string | null;
        claimed: boolean;
      }>(
        `SELECT a.id, a.read_event_id, a.tribute_id, a.amount_pence, a.state,
                a.swept_return_kind,
                (a.tribute_payout_id IS NOT NULL OR a.swept_return_payout_id IS NOT NULL) AS claimed,
                t.parent_tribute_id, t.resolved_account_id, t.author_account_id,
                pt.resolved_account_id AS parent_resolved_account_id,
                pt.author_account_id  AS parent_author_account_id
         FROM tribute_accruals a
         JOIN tributes t ON t.id = a.tribute_id
         LEFT JOIN tributes pt ON pt.id = t.parent_tribute_id
         JOIN read_events re ON re.id = a.read_event_id
         WHERE re.tab_settlement_id = $1
           AND a.state <> 'voided'`,
        [settlement.id],
      );

      const planReads: ReversalRead[] = reads.map((r) => ({
        id: r.id,
        amountPence: r.amount_pence,
        state: r.state,
        writerId: r.writer_id,
      }));
      const planVotes: ReversalVote[] = votes.map((v) => ({
        id: v.id,
        amountPence: v.amount_pence,
        state: v.state,
        recipientId: v.recipient_id,
      }));
      const planAccruals: ReversalAccrual[] = accrualRows.map((a) => ({
        id: a.id,
        readEventId: a.read_event_id,
        tributeId: a.tribute_id,
        parentTributeId: a.parent_tribute_id,
        amountPence: a.amount_pence,
        state: a.state,
        resolvedAccountId: a.resolved_account_id,
        authorAccountId: a.author_account_id,
        parentResolvedAccountId: a.parent_resolved_account_id,
        parentAuthorAccountId: a.parent_author_account_id,
        sweptReturnKind: a.swept_return_kind,
        claimed: a.claimed,
      }));

      const plan = computeChargebackReversal({
        readerId: settlement.reader_id,
        settlementAmountPence: settlement.amount_pence,
        reads: planReads,
        votes: planVotes,
        accruals: planAccruals,
        platformFeeBps: config.platformFeeBps,
      });

      // Restore the reader's tab — the settlement credit is clawed back, so the
      // debt returns. No clamp (negative permitted): the column and its ledger
      // entry move by the same signed delta.
      await client.query(
        `UPDATE reading_tabs
         SET balance_pence = balance_pence + $1, updated_at = now()
         WHERE id = $2`,
        [plan.tabRestorePence, settlement.tab_id],
      );

      // All reversal ledger entries (reader first, then writer/tribute), each
      // referencing the settlement that was reversed.
      for (const entry of plan.ledgerEntries) {
        await recordLedger(client, {
          accountId: entry.accountId,
          counterpartyId: entry.counterpartyId,
          amountPence: entry.amountPence,
          triggerType: entry.trigger,
          refTable: "tab_settlements",
          refId: settlement.id,
        });
      }

      if (plan.chargeBackReadIds.length > 0) {
        await client.query(
          `UPDATE read_events
           SET state = 'charged_back', state_updated_at = now()
           WHERE id = ANY($1::uuid[])`,
          [plan.chargeBackReadIds],
        );
      }
      if (plan.chargeBackVoteIds.length > 0) {
        await client.query(
          `UPDATE vote_charges SET state = 'charged_back' WHERE id = ANY($1::uuid[])`,
          [plan.chargeBackVoteIds],
        );
      }
      if (plan.voidAccrualIds.length > 0) {
        await client.query(
          `UPDATE tribute_accruals SET state = 'voided' WHERE id = ANY($1::uuid[])`,
          [plan.voidAccrualIds],
        );
      }

      logger.warn(
        {
          settlementId: settlement.id,
          stripeChargeId,
          reason,
          reads: plan.chargeBackReadIds.length,
          votes: plan.chargeBackVoteIds.length,
          voidedAccruals: plan.voidAccrualIds.length,
          ledgerEntries: plan.ledgerEntries.length,
        },
        "Settlement reversed — reader debt restored, reads charged back",
      );
    });
  }

  // ---------------------------------------------------------------------------
  // reconcileSettlements — backstop for MISSED payment_intent.succeeded webhooks.
  //
  // completeSettlement flips a settlement to 'completed' the instant the Stripe
  // PaymentIntent is created (the reader's card is charged), but the tab debit,
  // the reader ledger credit, and the read/vote/tribute advancement all happen
  // in confirmSettlement — which runs ONLY on the payment_intent.succeeded
  // webhook. Stripe delivers webhooks at-least-once, not always-once: a single
  // dropped event leaves the reader CHARGED with no corresponding tab/ledger
  // movement and reads stuck 'accrued' forever, with no error. This is the
  // settlement-side twin of reconcileConnectKyc — it re-reads the PaymentIntent
  // straight from Stripe and confirms it.
  //
  // Candidate = a 'completed' settlement whose stripe_charge_id is still NULL
  // (confirmSettlement is what sets it) and which is older than the grace window
  // (so we never race the normal webhook for a settlement Stripe is still
  // processing). confirmSettlement is idempotent (guards on the charge claim),
  // so a flip the webhook ALSO lands is a safe no-op.
  // ---------------------------------------------------------------------------
  async reconcileSettlements(): Promise<{ checked: number; confirmed: number }> {
    const { rows: candidates } = await pool.query<{
      id: string;
      stripe_payment_intent_id: string;
    }>(
      `SELECT id, stripe_payment_intent_id
         FROM tab_settlements
        WHERE status = 'completed'
          AND stripe_charge_id IS NULL
          AND stripe_payment_intent_id IS NOT NULL
          AND created_at < now() - interval '1 hour'
        ORDER BY created_at ASC
        LIMIT 200`,
    );

    let confirmed = 0;
    for (const c of candidates) {
      let pi: Stripe.PaymentIntent;
      try {
        pi = await this.stripe.paymentIntents.retrieve(
          c.stripe_payment_intent_id,
        );
      } catch (err) {
        // 429 / transient / not-found — log and move on; next sweep retries.
        logger.warn(
          { err, settlementId: c.id, paymentIntentId: c.stripe_payment_intent_id },
          "Settlement reconcile: paymentIntents.retrieve failed — will retry next sweep",
        );
        continue;
      }

      if (pi.status !== "succeeded") {
        // Not yet paid (or failed). A still-processing PI is re-checked next
        // sweep; a genuinely failed one will arrive via payment_intent.payment_failed.
        continue;
      }

      const chargeId =
        typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : (pi.latest_charge?.id ?? "");
      if (!chargeId) {
        logger.warn(
          { settlementId: c.id, paymentIntentId: pi.id },
          "Settlement reconcile: succeeded PaymentIntent has no latest_charge — skipping",
        );
        continue;
      }

      try {
        await this.confirmSettlement(pi.id, chargeId);
        confirmed++;
        logger.info(
          { settlementId: c.id, paymentIntentId: pi.id, chargeId },
          "Settlement reconcile: confirmed via sweep — payment_intent.succeeded webhook was missed",
        );
      } catch (err) {
        logger.error(
          { err, settlementId: c.id, paymentIntentId: pi.id },
          "Settlement reconcile: confirmSettlement failed — will retry next sweep",
        );
      }
    }

    if (candidates.length > 0) {
      logger.info(
        { checked: candidates.length, confirmed },
        "Settlement reconcile sweep complete",
      );
    }
    return { checked: candidates.length, confirmed };
  }
}

export const settlementService = new SettlementService();
