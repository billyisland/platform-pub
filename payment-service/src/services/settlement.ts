import Stripe from "stripe";
import type { PlatformConfig } from "../types/index.js";
import {
  pool,
  withTransaction,
  loadConfig,
} from "@platform-pub/shared/db/client.js";
import { recordLedger, applyLedgerDelta } from "@platform-pub/shared/lib/ledger.js";
import { tributesEnabled } from "@platform-pub/shared/lib/env.js";
import { readNetSql } from "@platform-pub/shared/lib/per-read-net.js";
import { isTerminalChargeError } from "../lib/charge-errors.js";
import {
  executeStripeIdempotent,
  stripeErrorCode,
} from "../lib/stripe-idempotent.js";
import {
  computeChargebackReversal,
  type ReversalRead,
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
    const outcome = await executeStripeIdempotent(
      "settlement",
      `settlement-${settlementId}`,
      () =>
        this.stripe.paymentIntents.create(
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
        ),
      isTerminalChargeError,
    );
    if (!outcome.ok) {
      // Terminal decline / SCA / unusable card: mark the settlement 'failed' so
      // the reserveSettlement pending-guard releases and the tab unfreezes, and
      // flag the account so settlement backs off until the reader re-attaches a
      // card. Without this the row stays 'pending' forever (STRIPE audit S1, P0).
      // (Transient errors never reach here — the primitive re-throws them so
      // resumePendingSettlements retries with the stable key; the charge may
      // have succeeded, so it must NOT be marked failed.)
      const err = outcome.err;
      const piId =
        (err as { payment_intent?: { id?: string } }).payment_intent?.id ??
        (err as { raw?: { payment_intent?: { id?: string } } }).raw
          ?.payment_intent?.id ??
        null;
      const code = stripeErrorCode(err, "charge_failed");
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
    const paymentIntent = outcome.object;

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
  // sweepDueSettlements — periodic threshold sweep (2026-07-06 audit P0/P1).
  //
  // checkAndSettle otherwise fires ONLY on a paid gate pass and on card-connect,
  // so tab debt that grows without gate passes was never collected: subscription
  // charges (renewals land on the tab from the gateway worker, which never
  // touches payment-service) and any reader who simply stops reading below the
  // monthly-fallback window. Runs from the settlement-reconcile worker cycle;
  // mirrors checkAndSettle's own preconditions (card on file, no back-off flag)
  // in the scan so we don't loop no-op candidates.
  // ---------------------------------------------------------------------------

  async sweepDueSettlements(): Promise<number> {
    const config = await loadConfig();
    const BATCH = 500;
    const { rows } = await pool.query<{ reader_id: string }>(
      `SELECT t.reader_id
       FROM reading_tabs t
       JOIN accounts a ON a.id = t.reader_id
       WHERE t.balance_pence >= $1
         AND a.stripe_customer_id IS NOT NULL
         AND a.card_action_required_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM tab_settlements ts
           WHERE ts.tab_id = t.id AND ts.status = 'pending'
         )
       LIMIT $2`,
      [config.tabSettlementThresholdPence, BATCH],
    );
    if (rows.length === BATCH) {
      // Not silent truncation: the remainder is picked up next cycle, but a
      // full batch is worth an operator's eye (3 sweeps/day × 500).
      logger.warn(
        { batch: BATCH },
        "Settlement sweep hit its batch cap — more tabs remain due",
      );
    }
    let initiated = 0;
    for (const row of rows) {
      try {
        if (await this.checkAndSettle(row.reader_id, "threshold")) initiated++;
      } catch (err) {
        logger.error(
          { err, readerId: row.reader_id },
          "Threshold sweep settlement failed",
        );
      }
    }
    return initiated;
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

      // Lock the tab BEFORE claiming the settlement row, so this path acquires
      // {reading_tabs, tab_settlements} in the SAME order as reserveSettlement
      // (178→224) and reverseSettlement (864→871): reading_tabs first, then
      // tab_settlements. Without this, confirmSettlement locked tab_settlements
      // (the UPDATE below) before reading_tabs (the balance UPDATE further down),
      // the reverse order — so a reconcile-driven confirmSettlement racing a
      // reverseSettlement (refund/dispute webhook) on the same settlement could
      // deadlock (each holding one row, waiting for the other). We already hold
      // this lock through the balance debit below, so there is no extra round.
      await client.query(
        "SELECT balance_pence FROM reading_tabs WHERE id = $1 FOR UPDATE",
        [settlement.tab_id],
      );

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

      // Reader credit — the Stripe charge pays the tab DOWN by the settled amount
      // (deltaPence = −amount), and applyLedgerDelta posts the mirror +amount
      // ledger entry as one indivisible, unclamped pair (counterparty = platform
      // / NULL). NO GREATEST(0, …) clamp: the amount was clamped to the locked
      // balance at reservation (reserveSettlement: actualAmount = min(lockedBalance,
      // expected)), so an over-settlement only arises if the balance dropped
      // between reserve and confirm (e.g. an interleaved subscription credit-back).
      // Flooring the column at 0 while the ledger credits the full amount would
      // break −SUM(ledger) == balance_pence permanently (the Phase-3 "agree to
      // the penny" guarantee); letting it go negative is correct (negative =
      // platform owes the reader / pre-paid credit). The tab was locked FOR UPDATE
      // above, before the tab_settlements claim, for the confirm↔reverse lock
      // ordering — applyLedgerDelta re-locks the same (already-held) row.
      await applyLedgerDelta(client, {
        accountId: settlement.reader_id,
        counterpartyId: null,
        deltaPence: -settlement.amount_pence,
        triggerType: "tab_settlement",
        refTable: "tab_settlements",
        refId: settlement.id,
        touch: ["last_settled_at"],
      });

      // Wave-5 P3 note: the `read_at <= settled_at` predicate advances every
      // accrued read on this tab whose read_at is at/before the settlement's
      // snapshot time — NOT only the reads whose amounts summed to the charged
      // amount. A read that accrued between the settlement's reservation and this
      // confirmation (so read_at <= settled_at but its amount was NOT in the
      // charged total) is therefore advanced under this settlement and earns its
      // writer a writer_accrual, while its penny is collected by the NEXT
      // settlement. Money conserves across settlements, but read↔settlement
      // attribution is APPROXIMATE — reconciliation queries must not assume an
      // exact per-settlement charge/read pairing.
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

      // Subscription twin of the read advance above (migration 146): this
      // settlement collected the FULL tab balance as of its reservation
      // snapshot, which includes every subscription_charge debited before it —
      // so the paired earnings become payable now. Same approximate attribution
      // as reads (created_at <= snapshot; a charge landing between reserve and
      // confirm rides the NEXT settlement). Charges fully funded by pre-paid
      // credit were stamped at charge time (logSubscriptionCharge). No ledger
      // row: the subscription_earning entry posted at charge time — this is
      // claim-state, not a money movement.
      await client.query(
        `UPDATE subscription_events
         SET settled_at = now()
         WHERE reader_id = $1
           AND event_type = 'subscription_earning'
           AND settled_at IS NULL
           AND created_at <= (SELECT settled_at FROM tab_settlements WHERE id = $2)`,
        [settlement.reader_id, settlement.id],
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
        // F2: publication reads carry the human author's writer_id but their
        // revenue belongs to the publication pool, not the author personally.
        // Skip them here so no personal writer_accrual is posted (and the earned
        // views / dashboard stop claiming pool money as personal earnings). The
        // reads still advanced to platform_settled above; the publication payout
        // cycle distributes them.
        `SELECT id, writer_id, ${readNetSql("amount_pence", "$2")} AS net_pence
         FROM read_events
         WHERE tab_settlement_id = $1 AND state = 'platform_settled'
           AND publication_id IS NULL`,
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

      // Tribute apportionment (Upstream Edges Phase 3 + Phase-5 chains, dark
      // behind TRIBUTES_ENABLED). DIAL A (consent-gated, forward-only accrual —
      // UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md › Decision 2026-07-13): a share is
      // frozen ONLY for a `live` tribute (consented + onboarding), and only on
      // reads that settle AFTER it went live — so nothing is ever held for a
      // non-consenting party. For each read just advanced to platform_settled on
      // an article with a `live` tribute, freeze one tribute_accruals row per
      // `live` NODE of the tribute tree: that node's GROSS inflow for THIS read =
      // read_net × (∏ bps along the node's path) ÷ 10000^pathlen, computed with
      // the fee bps of the moment and never recomputed. Every accrual is born
      // 'released' (its tribute is already live; there is no held→released flip).
      // A `proposed` node produces NO accrual — the recursive walk filters on
      // status = 'live' at every level, so a non-live node prunes itself AND its
      // descendants (a child earns a share of the parent's share; no live parent
      // share ⇒ no child accrual). Each carving party (author at depth 0, every
      // inspirer below) subtracts its DIRECT children's gross at payout —
      // conservation telescopes to author + Σ(every live node's retained) ==
      // read_net (no clamp; each node keeps its children's floor dust).
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
             SELECT t.id AS tribute_id, sr.read_event_id,
                    sr.read_net,
                    (t.percentage_bps::numeric / 10000) AS path_factor
             FROM tributes t
             JOIN settled_reads sr ON sr.article_id = t.article_id
             WHERE t.parent_tribute_id IS NULL
               AND t.status = 'live'
               AND t.deleted_at IS NULL
             UNION ALL
             -- Children: source-of-funds is the parent's share; multiply the
             -- factor. Only a live child accrues (Dial A) — a proposed child
             -- and everything below it is pruned here.
             SELECT c.id, parent.read_event_id,
                    parent.read_net,
                    parent.path_factor * (c.percentage_bps::numeric / 10000)
             FROM tree parent
             JOIN tributes c
               ON c.parent_tribute_id = parent.tribute_id
              AND c.status = 'live'
              AND c.deleted_at IS NULL
           )
           INSERT INTO tribute_accruals (tribute_id, read_event_id, amount_pence, state)
           SELECT tribute_id, read_event_id,
                  FLOOR(read_net * path_factor)::bigint,
                  'released'
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
  //
  // Audit F8 (2026-07-05): two hardenings.
  //   (a) Status guard. The flip is now `WHERE id = $1 AND status = 'pending'`
  //       (mirrors completeSettlement/confirmSettlement). A late or duplicate
  //       payment_intent.payment_failed arriving AFTER the settlement already
  //       reached 'completed' would otherwise flip completed → failed — state
  //       corruption. Only a still-pending settlement may be marked failed.
  //   (b) Back-off flag. On a genuine flip, set accounts.card_action_required_at
  //       (mirror of the synchronous terminal-decline path in completeSettlement)
  //       so checkAndSettle — which runs on EVERY gate pass — stops re-attempting
  //       against a known-bad card until the reader re-attaches one
  //       (connectPaymentMethod clears the flag). Without it, an async decline
  //       triggers a fresh settlement attempt per read: decline fees, issuer risk
  //       flags, pending-settlement churn.
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
        status: string;
      }>(
        `SELECT id, reader_id, tab_id, amount_pence, status
         FROM tab_settlements
         WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId],
      );

      if (settlementRow.rowCount === 0) return;

      const settlement = settlementRow.rows[0];

      const flipped = await client.query(
        `UPDATE tab_settlements SET status = 'failed'
         WHERE id = $1 AND status = 'pending'`,
        [settlement.id],
      );
      if (flipped.rowCount === 0) {
        logger.warn(
          { settlementId: settlement.id, paymentIntentId, status: settlement.status },
          "handleFailedPayment: settlement not 'pending' — ignoring (late/duplicate webhook)",
        );
        return;
      }

      // Back-off: settle no more against this card until it is re-attached.
      await client.query(
        `UPDATE accounts
         SET card_action_required_at = now(), updated_at = now()
         WHERE id = $1`,
        [settlement.reader_id],
      );

      logger.warn(
        { settlementId: settlement.id, paymentIntentId, failureMessage },
        "Payment failed — settlement marked failed, card-action flagged (back-off)",
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
  //   3. Load the reads / tribute accruals tied to this charge and hand them to
  //      the pure planner (chargeback.ts). Apply its plan: post the writer/
  //      tribute reversal entries, flip rolled-back reads to 'charged_back',
  //      void the unpaid accruals. (F9 removed the vote-charge reversal arm.)
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
        publication_id: string | null;
        writer_payout_id: string | null;
      }>(
        `SELECT id, amount_pence, state, writer_id, publication_id, writer_payout_id
         FROM read_events
         WHERE tab_settlement_id = $1
           AND state IN ('platform_settled', 'writer_paid')`,
        [settlement.id],
      );

      // F5: for the publication reads being charged back, load the paying
      // publication payout's pool (gross reads + subscription leg, §1.3) + its
      // PAID splits (initiated|completed —
      // money that actually left the platform) so the planner can reverse each
      // split recipient proportionally. A publication read's writer_payout_id is
      // a publication_payouts.id (the column is overloaded across payout kinds;
      // F2 keeps publication reads out of the individual writer cycle, so it is
      // never a writer_payouts.id here). NULL ⇒ pool not yet paid out → no split
      // reversal (charged back on the reader side only).
      const pubPayoutIds = [
        ...new Set(
          reads
            .filter((r) => r.publication_id !== null && r.writer_payout_id !== null)
            .map((r) => r.writer_payout_id as string),
        ),
      ];
      const poolByPayout = new Map<string, number>();
      const splitsByPayout = new Map<string, { accountId: string; amountPence: number }[]>();
      if (pubPayoutIds.length > 0) {
        const { rows: poolRows } = await client.query<{
          id: string;
          pool_pence: number;
        }>(
          // §1.3: the prorating denominator is the WHOLE pool the payout
          // distributed — gross reads + the subscription leg. Splits are paid
          // from both, but a read chargeback must only reverse the read-derived
          // slice: subscription debt on chargeback is the recorded
          // platform-absorbs posture (chargeback.ts header), so the sub leg
          // dilutes the read's share rather than being reversed itself.
          `SELECT id, total_pool_pence + sub_net_pence AS pool_pence
           FROM publication_payouts WHERE id = ANY($1::uuid[])`,
          [pubPayoutIds],
        );
        for (const p of poolRows) poolByPayout.set(p.id, p.pool_pence);

        const { rows: splitRows } = await client.query<{
          publication_payout_id: string;
          account_id: string;
          amount_pence: number;
        }>(
          `SELECT publication_payout_id, account_id, amount_pence
           FROM publication_payout_splits
           WHERE publication_payout_id = ANY($1::uuid[])
             AND status IN ('initiated', 'completed')`,
          [pubPayoutIds],
        );
        for (const s of splitRows) {
          const list = splitsByPayout.get(s.publication_payout_id);
          const entry = { accountId: s.account_id, amountPence: s.amount_pence };
          if (list) list.push(entry);
          else splitsByPayout.set(s.publication_payout_id, [entry]);
        }
      }

      // Every non-voided accrual on the reads this charge settled, with the
      // tribute (and its parent) so the planner can attribute net per node.
      // Dial A: an accrual is only ever released|paid, claimed iff a
      // tribute_payout_id reserved it (the swept-return vehicle is gone).
      const { rows: accrualRows } = await client.query<{
        id: string;
        read_event_id: string;
        tribute_id: string;
        parent_tribute_id: string | null;
        amount_pence: number;
        state: string;
        resolved_account_id: string;
        author_account_id: string;
        claimed: boolean;
      }>(
        `SELECT a.id, a.read_event_id, a.tribute_id, a.amount_pence, a.state,
                (a.tribute_payout_id IS NOT NULL) AS claimed,
                t.parent_tribute_id, t.resolved_account_id, t.author_account_id
         FROM tribute_accruals a
         JOIN tributes t ON t.id = a.tribute_id
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
        isPublication: r.publication_id !== null,
        publicationPoolPence:
          r.writer_payout_id !== null
            ? poolByPayout.get(r.writer_payout_id)
            : undefined,
        publicationSplits:
          r.writer_payout_id !== null
            ? splitsByPayout.get(r.writer_payout_id)
            : undefined,
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
        claimed: a.claimed,
      }));

      const plan = computeChargebackReversal({
        readerId: settlement.reader_id,
        settlementAmountPence: settlement.amount_pence,
        reads: planReads,
        accruals: planAccruals,
        platformFeeBps: config.platformFeeBps,
      });

      // Restore the reader's tab — the settlement credit is clawed back, so the
      // debt returns (deltaPence = +tabRestorePence). applyLedgerDelta moves the
      // column AND posts the reader's mirror `tab_settlement_reversal` entry
      // (−tabRestorePence == plan's reader entry) as one unclamped pair; that
      // entry is therefore EXCLUDED from the writer/tribute-leg loop below (those
      // legs are pure ledger reversals, no column). No clamp (negative permitted).
      await applyLedgerDelta(client, {
        accountId: settlement.reader_id,
        counterpartyId: null,
        deltaPence: plan.tabRestorePence,
        triggerType: "tab_settlement_reversal",
        refTable: "tab_settlements",
        refId: settlement.id,
      });

      // Audit F12 (2026-07-05): gate re-collection after a chargeback. The debt
      // restore above is ledger-correct, but the next threshold crossing would
      // otherwise auto-recharge the same card for the exact amount the cardholder
      // just disputed — which card networks punish (repeat disputes, monitoring
      // programmes). Set the settlement back-off flag (reused from the decline
      // path; cleared when the reader re-attaches a card) so collection is gated
      // on an explicit card re-attach rather than fired automatically. The debt
      // is preserved; only automatic collection is held. Re-consent-before-resume
      // is deferred — this is the hold-flag posture chosen 2026-07-05.
      await client.query(
        `UPDATE accounts
         SET card_action_required_at = now(), updated_at = now()
         WHERE id = $1`,
        [settlement.reader_id],
      );

      // Writer/tribute reversal ledger entries — pure ledger legs, no column.
      // The reader's `tab_settlement_reversal` entry is skipped: applyLedgerDelta
      // above already posted it as the mirror of the tab restore (posting it here
      // too would double-count the reader credit-back).
      for (const entry of plan.ledgerEntries) {
        if (entry.trigger === "tab_settlement_reversal") continue;
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
