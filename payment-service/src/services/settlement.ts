import Stripe from "stripe";
import type { PlatformConfig } from "@platform-pub/shared/types/config.js";
import {
  pool,
  withTransaction,
  loadConfig,
} from "@platform-pub/shared/db/client.js";
import { recordLedger, applyLedgerDelta } from "@platform-pub/shared/lib/ledger.js";
import { readNetSql } from "@platform-pub/shared/lib/per-read-net.js";
import {
  isTerminalChargeError,
  isIdempotencyConflict,
} from "../lib/charge-errors.js";
import {
  createAllocationAwareStripe,
  allocatedFundsParam,
  readAllocatedBalance,
  type ChargeWithAllocatedFunds,
} from "../lib/stripe-client.js";
import { tributesEnabled, allocatedFundsEnabled } from "@platform-pub/shared/lib/env.js";
import {
  executeStripeIdempotent,
  stripeErrorCode,
  type StripeIdempotentOutcome,
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

// One full settlement-reconcile cycle (the worker runs 3×/day). A pending row
// that has survived a whole cycle of retries is wedged, not in flight — and a
// wedged pending row freezes its tab via the in-flight guard, so it must never
// linger silently (§0o.1: three did, for days). Alert-only: resolution stays
// with the retry/recovery paths, never a blind timeout-fail (the charge may
// exist — failing it here is the double-charge, PAYMENTS ADR §1.1).
const STUCK_PENDING_ALERT_HOURS = 8;

/**
 * The reserve-time guard: is a settlement already IN FLIGHT on this tab?
 *
 * Exported so the DB-backed test runs THIS statement rather than a copy of it —
 * a re-typed predicate in a test pins the copy and lets production drift.
 *
 * Two arms, and the second is the one that was missing. A settlement leaves
 * `pending` when Stripe returns, but the tab's balance is not reduced until
 * confirmSettlement runs on the payment_intent.succeeded webhook. In that gap
 * the tab still reads full, so a `pending`-only guard admitted a second
 * settlement and charged the reader twice (measured 2026-07-31 — see the note
 * at the call site). `stripe_charge_id IS NULL` is the same marker
 * reconcileSettlements uses for "charged but not yet applied", and that sweep
 * is what bounds the SECOND arm.
 *
 * The `pending` arm is bounded only by resumePendingSettlements (startup +
 * every reconcile cycle) SUCCEEDING: a persistently-ambiguous Stripe error
 * holds the tab frozen for as long as it persists. The one such error a retry
 * can never clear — the idempotency key conflict — is recovered specifically
 * (recoverIdempotencyConflict, §0o.1), and anything else that lingers past a
 * full retry cycle trips the resume sweep's stuck-pending age alert rather
 * than freezing silently.
 */
export const SETTLEMENT_IN_FLIGHT_SQL = `
  SELECT id, status
    FROM tab_settlements
   WHERE tab_id = $1
     AND (status = 'pending'
          OR (status = 'completed' AND stripe_charge_id IS NULL))
   LIMIT 1`;

class SettlementService {
  private stripe: Stripe;

  constructor() {
    // Allocation-aware: under STRIPE_ALLOCATED_FUNDS this client speaks the
    // preview API version, because it both WRITES allocation (the settlement PI)
    // and READS it back (the allocation-sync sweep). Flag off ⇒ 2023-10-16,
    // exactly as before. See lib/stripe-client.ts for why the version is cast
    // rather than the SDK upgraded.
    this.stripe = createAllocationAwareStripe();
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

      // Check for a settlement already IN FLIGHT on this tab.
      //
      // "In flight" is wider than `pending`, and the difference double-charged a
      // reader. The tab's balance is not reduced at reservation, nor when Stripe
      // returns — it moves only at confirmSettlement, which runs on the
      // payment_intent.succeeded WEBHOOK. But the row leaves `pending` the
      // instant the charge returns (completeSettlement). So between those two
      // moments a settlement has taken the reader's money while the tab still
      // shows the full balance and the old `status = 'pending'` guard let a
      // second one straight through.
      //
      // Measured 2026-07-31 against the segregation sandbox: settlement A
      // reserved at 11:01:11.324 and correctly turned away three concurrent
      // attempts; A completed at 11:01:12.787; B reserved at 11:01:12.845 —
      // 58ms later — and A only confirmed at 11:01:13.163. The reader was
      // charged twice for one £14 debt and the tab went to −1400 (legal, as
      // pre-paid credit, which is why nothing alerted). A third settlement
      // reserved 1.3s after that, so it cascades.
      //
      // `stripe_charge_id IS NULL` is the established marker for "charged but
      // not yet applied to the tab" — reconcileSettlements selects on exactly
      // that pair to recover a settlement whose webhook never arrived, so a tab
      // blocked here is released by that sweep at the latest, never frozen. A
      // delayed collection is the safe direction; a duplicate charge is not.
      const inFlight = await client.query<{ id: string; status: string }>(
        SETTLEMENT_IN_FLIGHT_SQL,
        [tabId],
      );
      if (inFlight.rowCount! > 0) {
        logger.info(
          {
            tabId,
            existingSettlementId: inFlight.rows[0].id,
            existingStatus: inFlight.rows[0].status,
          },
          "Settlement already in flight on this tab — skipping",
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

  // ---------------------------------------------------------------------------
  // resolveDefaultPaymentMethod — the card the reader attached, by id.
  //
  // A PaymentIntent does NOT inherit `invoice_settings.default_payment_method`.
  // That field governs INVOICES and SUBSCRIPTIONS; a PI confirmed with only a
  // `customer` set has no payment method at all, and Stripe rejects it with
  // `payment_intent_unexpected_state` — a StripeInvalidRequestError, which
  // isTerminalChargeError correctly classes as TERMINAL. So the settlement was
  // marked failed and the reader's card flagged as needing action, on every
  // attempt, for a card that was never anything but fine.
  //
  // Measured against the segregation sandbox 2026-07-31 with a paired control:
  // the identical create WITHOUT `payment_method` returns that error and WITH it
  // returns a succeeded PI. Nothing in the mocked suite could see it — the mock
  // answers the call, and Stripe is the only thing that knows this rule.
  //
  // Reading it back per settlement (rather than storing the id on the account)
  // keeps Stripe the single source of truth for which card is current: a reader
  // who re-attaches or updates a card changes it there, and a stored copy would
  // silently go stale and charge a dead card.
  // ---------------------------------------------------------------------------

  // Returns the card's BRAND alongside its id, because the allocated-funds param
  // must not be sent for a brand the beta will not accept (see
  // `allocatedFundsParam` — asking anyway 500s the create and wedges the tab
  // permanently). Expanding the default payment method here costs NO extra API
  // call: this retrieve was already being made, and `expand` rides along with
  // it. A brand we cannot read comes back null and default-denies, which is the
  // safe direction.
  private async resolveDefaultPaymentMethod(
    stripeCustomerId: string,
  ): Promise<{ id: string; brand: string | null } | null> {
    const customer = await this.stripe.customers.retrieve(stripeCustomerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    if (customer.deleted) return null;
    const pm = customer.invoice_settings?.default_payment_method ?? null;
    if (!pm) return null;
    if (typeof pm === "string") {
      // Expansion declined (a deleted/inaccessible PM): we still have the id, so
      // charge with it — but with no brand, allocation is default-denied.
      return { id: pm, brand: null };
    }
    return { id: pm.id, brand: pm.card?.brand ?? null };
  }

  private async completeSettlement(
    settlementId: string,
    amountPence: number,
    stripeCustomerId: string,
    readerId: string,
    tabId: string,
    triggerType: "threshold" | "monthly_fallback",
  ): Promise<void> {
    // Resolved OUTSIDE executeStripeIdempotent on purpose: a transient failure
    // here must propagate so resumePendingSettlements retries the row under its
    // stable key, exactly as an ambiguous create would. Only a customer that
    // resolves to no usable card is terminal, and that is handled below.
    const defaultCard =
      await this.resolveDefaultPaymentMethod(stripeCustomerId);
    const paymentMethodId = defaultCard?.id ?? null;

    if (!paymentMethodId) {
      // Genuinely a card problem — the reader has a customer record but no
      // default card on it. Same disposition as a decline: release the pending
      // guard so the tab unfreezes, and flag for re-attach.
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE tab_settlements
             SET status = 'failed', failure_reason = $1
             WHERE id = $2 AND status = 'pending'`,
          ["no_default_payment_method", settlementId],
        );
        await client.query(
          `UPDATE accounts
             SET card_action_required_at = now(), updated_at = now()
             WHERE id = $1`,
          [readerId],
        );
      });
      logger.warn(
        { settlementId, readerId, stripeCustomerId },
        "Settlement skipped — customer has no default payment method, card-action flagged",
      );
      return;
    }

    let outcome: StripeIdempotentOutcome<Stripe.Response<Stripe.PaymentIntent>>;
    try {
      outcome = await this.createSettlementIntent(
        settlementId,
        amountPence,
        stripeCustomerId,
        readerId,
        tabId,
        triggerType,
        paymentMethodId,
        defaultCard?.brand ?? null,
      );
    } catch (err) {
      // The one ambiguous error a retry can never clear: the payload drifted
      // under the row-stable key (deploy / card swap / brand flip — §0o.1).
      // Resolve it by looking the first attempt's PI up instead of re-throwing
      // into an infinite conflict loop that freezes the tab.
      if (!isIdempotencyConflict(err)) throw err;
      await this.recoverIdempotencyConflict(
        settlementId,
        stripeCustomerId,
        readerId,
      );
      return;
    }
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

  // The Stripe create, factored out only so completeSettlement can catch the
  // idempotency-conflict case around it; classification (terminal vs ambiguous)
  // stays executeStripeIdempotent's.
  private createSettlementIntent(
    settlementId: string,
    amountPence: number,
    stripeCustomerId: string,
    readerId: string,
    tabId: string,
    triggerType: "threshold" | "monthly_fallback",
    paymentMethodId: string,
    cardBrand: string | null,
  ): Promise<StripeIdempotentOutcome<Stripe.Response<Stripe.PaymentIntent>>> {
    return executeStripeIdempotent(
      "settlement",
      `settlement-${settlementId}`,
      () =>
        this.stripe.paymentIntents.create(
          {
            amount: amountPence,
            currency: "gbp",
            customer: stripeCustomerId,
            // Deliberately BROADER than the allocated-funds beta's eligible brand
            // set. A brand allow-list HERE would refuse a reader's card at
            // settlement time, turning a compliance nicety into lost revenue; the
            // allow-list belongs on the allocation param instead (below), so an
            // ineligible card is charged normally and simply carries no
            // segregated balance. NEVER switch this to
            // automatic_payment_methods.
            //
            // The older form of this comment claimed an ineligible brand "simply
            // yields a charge whose allocated balance syncs to 0". Measured
            // 2026-08-01: it does not — with `allocated_funds` set, the create
            // 500s and no charge exists at all. That is why the brand is now
            // pre-flighted rather than assumed; the INTENT of this comment is
            // unchanged and is what the pre-flight restores.
            payment_method_types: ["card"],
            // The reader's attached card, by id. A PI does not inherit the
            // customer's invoice_settings default — see
            // resolveDefaultPaymentMethod above for what omitting this cost.
            payment_method: paymentMethodId,
            confirm: true,
            off_session: true,
            // Lock this charge's funds into the allocated state — flag on AND
            // the card's brand accepted by the beta. An ineligible brand gets {}
            // here and charges perfectly normally, unallocated; asking anyway
            // 500s the create and wedges this tab forever (see
            // allocatedFundsParam for the full failure chain).
            ...allocatedFundsParam(cardBrand),
            // Grouping only — it buys legibility in the dashboard and nothing
            // else; source_transaction on the transfer is what does the work.
            ...(allocatedFundsEnabled()
              ? { transfer_group: `settlement-${settlementId}` }
              : {}),
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
  }

  // ---------------------------------------------------------------------------
  // recoverIdempotencyConflict — resolve the one ambiguous create error a retry
  // can never clear (2026-08-03 audit §0o.1).
  //
  // completeSettlement rebuilds its create payload on every attempt (the default
  // card is re-resolved live; the allocation param depends on its brand), so the
  // payload can drift between an ambiguous first attempt and its resume: a
  // deploy changing the create shape, the reader swapping default cards, a
  // brand-eligibility flip. The row-stable key then makes every retry a
  // StripeIdempotencyError, which is (correctly) ambiguous — so the row stayed
  // 'pending' and the in-flight guard froze the tab forever, silently. Measured
  // live: three dev settlements wedged this way, 2026-07-31.
  //
  // A key conflict is uniquely RESOLVABLE ambiguity: it proves the first request
  // reached Stripe and was recorded, and every settlement PI carries
  // metadata.settlement_id. So look the PaymentIntent up instead of retrying:
  //
  //   • found, succeeded/processing → ADOPT it: the first attempt's charge IS
  //     the settlement's charge. Store its id + flip 'completed'; confirm
  //     immediately when the charge id is already known, else the webhook (which
  //     matches on the now-stored PI id) or reconcileSettlements finishes.
  //   • found, dead (requires_payment_method / requires_action / canceled) →
  //     the terminal-decline disposition: 'failed' + card-action flag.
  //   • provably absent → the first request errored before creating anything
  //     (e.g. the measured allocation-on-ineligible-brand 500). Mark 'failed'
  //     WITHOUT the card flag — the card was never the problem — and the
  //     threshold sweep re-reserves a FRESH row whose fresh key charges cleanly
  //     under the current payload.
  //   • enumeration truncated → absence unproven, so change NOTHING (failing
  //     here could double-charge); the stuck-pending age alert keeps it visible.
  //
  // Enumeration is paymentIntents.LIST, never .search: the search index lags,
  // and a lagged miss here would read as "provably absent" and re-charge. The
  // window is bounded by the row's own created_at (the first request necessarily
  // post-dates the reserve), minus generous clock slack.
  // ---------------------------------------------------------------------------
  private async recoverIdempotencyConflict(
    settlementId: string,
    stripeCustomerId: string,
    readerId: string,
  ): Promise<void> {
    const { rows } = await pool.query<{ created_at: string | Date }>(
      `SELECT created_at FROM tab_settlements WHERE id = $1 AND status = 'pending'`,
      [settlementId],
    );
    if (rows.length === 0) return; // another path already moved the row on

    const createdGte =
      Math.floor(new Date(rows[0].created_at).getTime() / 1000) - 3600;

    const MAX_PAGES = 10; // 1,000 PIs in the window — far past any real reader
    let match: Stripe.PaymentIntent | null = null;
    let sawWholeWindow = false;
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES && !match; page++) {
      const batch = await this.stripe.paymentIntents.list({
        customer: stripeCustomerId,
        created: { gte: createdGte },
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      match =
        batch.data.find((pi) => pi.metadata?.settlement_id === settlementId) ??
        null;
      if (!batch.has_more) {
        sawWholeWindow = true;
        break;
      }
      startingAfter = batch.data[batch.data.length - 1]?.id;
      if (!startingAfter) break; // has_more on an empty page: treat as truncated
    }

    if (match) {
      if (match.status === "succeeded" || match.status === "processing") {
        await pool.query(
          `UPDATE tab_settlements
             SET stripe_payment_intent_id = $1, status = 'completed'
             WHERE id = $2 AND status = 'pending'`,
          [match.id, settlementId],
        );
        logger.warn(
          {
            settlementId,
            readerId,
            paymentIntentId: match.id,
            piStatus: match.status,
          },
          "Idempotency-conflict recovery: adopted the PaymentIntent the first attempt created",
        );
        if (match.status === "succeeded") {
          const chargeId =
            typeof match.latest_charge === "string"
              ? match.latest_charge
              : (match.latest_charge?.id ?? null);
          if (chargeId) {
            try {
              await this.confirmSettlement(match.id, chargeId);
            } catch (err) {
              // Adoption is already durable; confirmation lands via the webhook
              // (the PI id now matches) or the reconcileSettlements backstop.
              logger.warn(
                { err, settlementId, paymentIntentId: match.id },
                "Idempotency-conflict recovery: adopted but immediate confirm failed — reconcile sweep will finish",
              );
            }
          }
        }
        return;
      }
      if (
        match.status === "requires_payment_method" ||
        match.status === "requires_action" ||
        match.status === "canceled"
      ) {
        // The first attempt's charge is dead without the reader acting — the
        // terminal-decline disposition (mirrors completeSettlement's !ok arm).
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE tab_settlements
               SET status = 'failed',
                   stripe_payment_intent_id = COALESCE($1, stripe_payment_intent_id),
                   failure_reason = $2
               WHERE id = $3 AND status = 'pending'`,
            [match!.id, match!.status, settlementId],
          );
          await client.query(
            `UPDATE accounts
               SET card_action_required_at = now(), updated_at = now()
               WHERE id = $1`,
            [readerId],
          );
        });
        logger.warn(
          {
            settlementId,
            readerId,
            paymentIntentId: match.id,
            piStatus: match.status,
          },
          "Idempotency-conflict recovery: first attempt's PaymentIntent is dead — settlement failed, tab unfrozen, card-action flagged",
        );
        return;
      }
      // requires_confirmation / requires_capture — states a confirm-and-capture
      // create never mints. Change nothing; the age alert keeps it visible.
      logger.error(
        { settlementId, paymentIntentId: match.id, piStatus: match.status },
        "Idempotency-conflict recovery: PaymentIntent in a state this flow never mints — leaving pending for manual review",
      );
      return;
    }

    if (!sawWholeWindow) {
      logger.error(
        { settlementId, stripeCustomerId },
        "Idempotency-conflict recovery: window enumeration truncated, absence unproven — leaving pending",
      );
      return;
    }

    // Key recorded, provably no PaymentIntent: the first request errored before
    // creating anything. Fail WITHOUT the card flag — the card was never the
    // problem — so the threshold sweep re-reserves under a fresh id and key.
    await pool.query(
      `UPDATE tab_settlements
         SET status = 'failed',
             stripe_payment_intent_id = COALESCE($1, stripe_payment_intent_id),
             failure_reason = $2
         WHERE id = $3 AND status = 'pending'`,
      [null, "idempotency_key_conflict", settlementId],
    );
    logger.warn(
      { settlementId, readerId },
      "Idempotency-conflict recovery: key recorded but no PaymentIntent exists — settlement failed (no card flag); the sweep re-reserves under a fresh key",
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
      created_at: string | Date;
    }>(
      `SELECT id, reader_id, tab_id, amount_pence, trigger_type, created_at
       FROM tab_settlements
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    );

    if (rows.length === 0) return;

    const stale = rows.filter(
      (r) =>
        Date.now() - new Date(r.created_at).getTime() >
        STUCK_PENDING_ALERT_HOURS * 3600_000,
    );
    if (stale.length > 0) {
      logger.error(
        {
          count: stale.length,
          oldestCreatedAt: stale[0].created_at,
          settlementIds: stale.slice(0, 20).map((r) => r.id),
        },
        "SETTLEMENT STUCK PENDING — rows have survived at least one full retry cycle; each freezes its tab via the in-flight guard until resolved. The per-row error logged below is not clearing on its own — investigate it.",
      );
    }

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
          // Same disposition as the no-default-card branch in
          // completeSettlement (§0o.7b): a reader with no customer record has
          // no card to charge, so failing the row silently left them never
          // prompted to attach one — the tab unfroze but nothing told the
          // reader why settlement stopped. Flag for (re-)attach in the same
          // transaction as the failure.
          await withTransaction(async (client) => {
            await client.query(
              `UPDATE tab_settlements
                 SET status = 'failed', failure_reason = $1
                 WHERE id = $2 AND status = 'pending'`,
              ["no_stripe_customer", row.id],
            );
            await client.query(
              `UPDATE accounts
                 SET card_action_required_at = now(), updated_at = now()
                 WHERE id = $1`,
              [row.reader_id],
            );
          });
          logger.warn(
            { settlementId: row.id, tabId: row.tab_id, readerId: row.reader_id },
            "Cannot resume settlement — no stripe_customer_id; failed and card-action flagged",
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
  //
  // `settlementIdHint` is the webhook's `metadata.settlement_id` (§0o.7c): a PI
  // created just before a crash may never have had its id stored (the UPDATE at
  // the end of completeSettlement), and such a row was previously reachable
  // only through the resume sweep's same-key dedupe — the channel §0o.1 showed
  // can wedge on payload drift. The metadata the create stamps (and the §0o.1
  // recovery already matches on) lets the success webhook confirm it directly.
  // Adoption is guarded three ways: the row must still carry NO PI id (a row
  // owned by a DIFFERENT intent is never clobbered), the adopting UPDATE is
  // rowCount-checked under the tab lock (a lost race defers to the winner), and
  // the failed/duplicate dispositions run before it exactly as for a normal
  // match.
  // ---------------------------------------------------------------------------

  async confirmSettlement(
    paymentIntentId: string,
    stripeChargeId: string,
    settlementIdHint: string | null = null,
  ): Promise<void> {
    await withTransaction(async (client) => {
      let settlementRow = await client.query<{
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

      let adopting = false;
      if (settlementRow.rowCount === 0 && settlementIdHint) {
        // §0o.7c fallback — only a row that never learned ANY intent id is a
        // candidate; the IS NULL guard is what keeps a stray success for some
        // other PI from stealing a row that belongs to a different attempt.
        settlementRow = await client.query(
          `SELECT id, reader_id, tab_id, amount_pence, stripe_charge_id, status
           FROM tab_settlements
           WHERE id = $1 AND stripe_payment_intent_id IS NULL`,
          [settlementIdHint],
        );
        adopting = (settlementRow.rowCount ?? 0) > 0;
        if (adopting) {
          logger.warn(
            { paymentIntentId, settlementId: settlementIdHint },
            "confirmSettlement: PI unknown by id — adopting via metadata.settlement_id (crash before the id was stored)",
          );
        }
      }

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

      if (adopting) {
        // AFTER the tab lock, never before — an early tab_settlements write
        // would take its row lock ahead of reading_tabs, the reverse of the
        // {reading_tabs, tab_settlements} order documented above. The IS NULL
        // re-check makes a lost adopt race a clean defer: whoever stored an id
        // meanwhile (the resume sweep's dedupe, a concurrent delivery) owns the
        // row, and if it is this same PI the ordinary claim below dedupes.
        // status = 'completed' rides the SAME update, and must: it is the
        // transition completeSettlement makes when it stores the id, and the
        // adopt is standing in for exactly that lost write. Left 'pending' the
        // row is a settled settlement wearing an in-flight label, and the label
        // is load-bearing twice over — reserveSettlement's in-flight guard reads
        // `status = 'pending'` (so the reader's NEXT debt cannot be collected
        // until a resume cycle, up to 8h), and resumePendingSettlements scans
        // the same predicate and re-drives the row through completeSettlement.
        // That re-drive is harmless while the card is still attached (the stable
        // key replays and the flip lands) but NOT otherwise: with the card gone
        // it takes the no-default-card arm and stamps 'failed' +
        // card_action_required_at on a settlement whose charge succeeded and
        // whose tab is already debited. Driven, 2026-08-05.
        const adopted = await client.query(
          `UPDATE tab_settlements
              SET stripe_payment_intent_id = $1, status = 'completed'
            WHERE id = $2 AND stripe_payment_intent_id IS NULL
              AND status = 'pending'`,
          [paymentIntentId, settlement.id],
        );
        if (adopted.rowCount === 0) {
          logger.warn(
            { paymentIntentId, settlementId: settlement.id },
            "confirmSettlement: adopt lost its race — another writer stored an intent id; deferring to it",
          );
          return;
        }
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

      // Reader credit — the Stripe charge pays the tab DOWN by the settled amount
      // (deltaPence = −amount), and applyLedgerDelta posts the mirror +amount
      // ledger entry as one indivisible, unclamped pair (counterparty = platform
      // / NULL). NO GREATEST(0, …) clamp: the amount was clamped to the locked
      // balance at reservation (reserveSettlement: actualAmount = min(lockedBalance,
      // expected)), so an over-settlement only arises if the balance dropped
      // between reserve and confirm (e.g. an interleaved subscription credit-back).
      // It USED to arise a second way, and that one was a duplicate charge rather
      // than an accounting edge: a second settlement reserving in the window
      // between the first one's Stripe response and its webhook confirmation,
      // when the tab still read full. reserveSettlement's in-flight guard closes
      // it — see the note there (measured 2026-07-31).
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
      //
      // tab_settlement_id (migration 165) is stamped in the SAME update that
      // sets settled_at, because it is the only moment the pairing is knowable:
      // afterwards the row carries a bare timestamp, and recovering "which
      // settlement stamped it" would need a time-join — reintroducing the
      // approximate read↔settlement attribution above at a second site. It is
      // the allocation packer's preferred funding charge. The charge-time
      // credit-funded branch (logSubscriptionCharge, post-charge balance <= 0)
      // leaves it NULL, which is correct: that earning has no charge behind it
      // and belongs in the residual.
      await client.query(
        `UPDATE subscription_events
         SET settled_at = now(),
             tab_settlement_id = $2
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
        `SELECT id, writer_id, ${readNetSql("chargeable_pence", "$2")} AS net_pence
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
                    ${readNetSql("re.chargeable_pence", "$2")}::numeric AS read_net
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
        chargeable_pence: number;
        state: string;
        writer_id: string;
        publication_id: string | null;
        writer_payout_id: string | null;
        publication_payout_id: string | null;
      }>(
        `SELECT id, chargeable_pence, state, writer_id, publication_id,
                writer_payout_id, publication_payout_id
         FROM read_events
         WHERE tab_settlement_id = $1
           AND state IN ('platform_settled', 'writer_paid')`,
        [settlement.id],
      );

      // F5: for the publication reads being charged back, load the paying
      // publication payout's pool (gross reads + subscription leg, §1.3) + its
      // PAID splits (initiated|completed —
      // money that actually left the platform) so the planner can reverse each
      // split recipient proportionally. A publication read's paying payout is on
      // `publication_payout_id` — its own column since migration 168. It used to
      // be read off `writer_payout_id`, on the reasoning that the column was
      // "overloaded across payout kinds"; it never was, because that column's FK
      // points at `writer_payouts`, so the claim raised 23503 and the value this
      // read was ALWAYS null. NULL ⇒ pool not yet paid out → no split reversal
      // (charged back on the reader side only).
      const pubPayoutIds = [
        ...new Set(
          reads
            .filter((r) => r.publication_id !== null && r.publication_payout_id !== null)
            .map((r) => r.publication_payout_id as string),
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
        chargeablePence: r.chargeable_pence,
        state: r.state,
        writerId: r.writer_id,
        isPublication: r.publication_id !== null,
        publicationPoolPence:
          r.publication_payout_id !== null
            ? poolByPayout.get(r.publication_payout_id)
            : undefined,
        publicationSplits:
          r.publication_payout_id !== null
            ? splitsByPayout.get(r.publication_payout_id)
            : undefined,
        // M3: an individual read claimed by a still-pending writer payout
        // (platform_settled + writer_payout_id set; completion would have flipped
        // it to writer_paid). The pending transfer's amount is locked and will
        // pay this read in full, so treat it as paid for the reversal.
        claimedByPendingPayout:
          r.publication_id === null &&
          r.state === 'platform_settled' &&
          r.writer_payout_id !== null,
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

  // ---------------------------------------------------------------------------
  // recordRefundDraw — a refund consumed part of a charge's allocation.
  //
  // Spec: FUNDS-SEGREGATION-INTEGRATION.md §3.5 (`charge.refunded`, both arms).
  //
  // WHY THE PARTIAL ARM IS A FLIP BLOCKER, not a nicety. A refund takes money
  // out of the charge, and under allocation it takes it out of the SEGREGATED
  // balance. Stripe's number drops; ours — `allocated_pence − Σ draws` — does
  // not, so the packer keeps offering a remainder the charge can no longer
  // fund, and the next payout builds a slice Stripe rejects. The full-refund
  // arm degrades gently (`reverseSettlement` moves the reads to
  // `charged_back`, so they leave the pool anyway), but the partial arm today
  // does nothing at all beyond a WARN: the reads stay `platform_settled` and
  // stay payable against a charge that has been drained. That is the wedge.
  //
  // ONE ROW PER SETTLEMENT, HOLDING THE CUMULATIVE TOTAL. Stripe reports
  // `charge.amount_refunded` cumulatively, so a second partial refund is a
  // larger absolute figure rather than an increment — the opposite of
  // `reverseChild`'s per-child deltas, which is why this upserts to GREATEST
  // rather than accumulating. GREATEST and not a bare assignment because
  // webhook delivery is not ordered: an out-of-order redelivery of the FIRST
  // partial must not shrink the budget back. Over-recording a refund can only
  // make us under-draw — the charge looks emptier than it is, its earnings
  // route to another charge or to the residual — which is the safe direction,
  // the same asymmetry `prorateWithheldFee` floors for.
  //
  // Deliberately NOT inside `reverseSettlement`'s transaction. It must run for
  // a partial refund, where that method is never called at all, and it must
  // still run when that method early-returns on an already-claimed reversal:
  // the allocation fact is independent of whether we have unwound the reads.
  //
  // A lost dispute is NOT handled here, per §3.5: disputed funds stay
  // allocated, and unallocating them takes a Stripe support request. For an
  // UNDRAWN charge the `syncAllocations` sweep is the backstop that eventually
  // re-reads the truth; a DRAWN charge is never re-stamped (see
  // syncAllocations), so there the backstop is the §3.6 divergence alert.
  // ---------------------------------------------------------------------------
  // Exported below the class as RECORD_REFUND_DRAW_SQL so the integration test
  // executes THIS statement rather than a copy — the upsert's monotonicity is a
  // property of the SQL and of the (ref_table, ref_id, kind) unique, so a test
  // running its own copy could not detect a regression here at all.
  async recordRefundDraw(
    stripeChargeId: string,
    amountRefundedPence: number,
  ): Promise<void> {
    if (!allocatedFundsEnabled()) return;
    if (amountRefundedPence <= 0) return;

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tab_settlements WHERE stripe_charge_id = $1`,
      [stripeChargeId],
    );
    if (rows.length === 0) {
      // Not a tab-settlement charge (a Connect charge, a test object). Same
      // posture as reverseSettlement's no-match arm: log, don't fail.
      logger.warn(
        { stripeChargeId, amountRefundedPence },
        "recordRefundDraw: no settlement for charge — ignoring",
      );
      return;
    }
    const settlementId = rows[0].id;

    await pool.query(RECORD_REFUND_DRAW_SQL, [settlementId, amountRefundedPence]);

    logger.info(
      { settlementId, stripeChargeId, amountRefundedPence },
      "Refund recorded against the charge's allocation budget",
    );
  }

  // ---------------------------------------------------------------------------
  // syncAllocations — read each charge's segregated balance BACK from Stripe.
  //
  // Spec: FUNDS-SEGREGATION-INTEGRATION.md §3.3a. The fourth sweep of the
  // settlement-reconcile worker, sharing its LIMIT 200 batch + oldest-first
  // shape.
  //
  // NEVER ASSUME ALLOCATION. Stripe gives us no queryable view of a charge's
  // remaining allocation, and several ordinary things make a charge carry LESS
  // than its amount — or none at all. This one mechanism disposes of three
  // separate problems, because in every case the charge is simply not drawable
  // and the packer routes around it identically:
  //
  //   • an ineligible card brand (payment_method_types: ['card'] is broader than
  //     the beta's Visa/MC/Amex/Discover/Swish, and such a charge carries NO
  //     allocated funds while a source_transaction transfer against it would
  //     still succeed from ordinary balance — the guarantee would lapse silently,
  //     with no error anywhere)
  //   • payment-method settlement timing (allocation becomes transferable after
  //     capture AND settlement; `pending` counts here because a
  //     source_transaction transfer QUEUES against that settlement rather than
  //     failing for insufficient balance)
  //   • the pre-flip transition (historical charges carry no allocation at all,
  //     stamp 0, and their earnings route to the residual — which is correct,
  //     the guarantee simply does not cover pre-flip funds)
  //
  // `allocated_pence` NULL means "not known to be drawable" and is the safe
  // default and the only default. This sweep is the sole writer.
  //
  // A DRAWN CHARGE IS NEVER RE-STAMPED (§0o.2, 2026-08-03). Stripe's reported
  // remaining is net of every EXECUTED draw, while the budget everywhere else
  // is `allocated_pence − Σ draws` — so re-stamping a drawn charge subtracts
  // its draws twice: sync 5000 → draw 2000 (Stripe now reports 3000) →
  // re-sync stamps 3000 → the budget reads 1000. Money-safe (under-draw by
  // construction) but coverage-destroying, and it made every drawn-then-
  // resynced charge diverge by exactly Σ draws forever, turning the §3.6
  // alert channel permanently red. So the staleness arm re-syncs only charges
  // with NO draws at all: once the first draw exists, the budget is
  // identity-maintained by the draws themselves (transfer draws at pack,
  // refund draws from the webhook, reversal returns from reverseChild), and
  // the §3.6 divergence sweep — which re-reads Stripe live and checks drawn
  // charges FIRST — is what catches real drift (an unrecorded refund, a lost
  // dispute, a missed reversal webhook).
  //
  // THE STAMP ADDS BACK REFUND DRAWS ALREADY ON THE ROW. A refund can precede
  // the first sync, and Stripe's remaining is already net of it — stamping
  // the raw figure would double-count the refund the same way. Stamping
  // `remaining + Σ refund draws` restores the identity
  // `allocated_pence − Σ draws == Stripe remaining` at the moment of sync.
  // Refund-kind ONLY, and the snapshot is read BEFORE the Stripe retrieve —
  // both so that every race errs toward under-draw:
  //   • a transfer draw must never be added back: a pack racing the undrawn
  //     re-sync arm inserts a draw whose transfer has NOT reached Stripe, so
  //     the retrieved remaining does not reflect it — it must stay
  //     subtracted, keeping the committed-but-unexecuted slice funded. (At
  //     FIRST sync it cannot exist at all: the packer refuses a NULL
  //     `allocated_pence` row, which is also why the add-back is complete
  //     there — pre-first-sync draws are refund-kind by construction.)
  //   • a refund landing between snapshot and stamp is missing from the
  //     add-back, so it is subtracted once against a possibly-pre-refund
  //     remaining — an under-draw, never an over-draw.
  //
  // Deliberately NOT done synchronously in completeSettlement or
  // confirmSettlement: the webhook path is already the critical,
  // idempotency-guarded path, and doing it out of band is also what makes the
  // design robust to settlement timing.
  // ---------------------------------------------------------------------------
  async syncAllocations(): Promise<{ checked: number; synced: number }> {
    if (!allocatedFundsEnabled()) return { checked: 0, synced: 0 };

    const config = await loadConfig();

    const { rows: candidates } = await pool.query<{
      id: string;
      stripe_payment_intent_id: string;
    }>(SYNC_ALLOCATION_CANDIDATES_SQL, [config.allocationSyncFreshnessHours]);

    let synced = 0;
    for (const c of candidates) {
      // Read the refund add-back BEFORE the Stripe retrieve (see the header:
      // a refund landing in between must err to under-draw, never over-draw).
      const { rows: snap } = await pool.query<{ refund_pence: string }>(
        SYNC_ALLOCATION_REFUND_SNAPSHOT_SQL,
        [c.id],
      );
      const refundAddBackPence = parseInt(snap[0].refund_pence, 10);

      let pi: Stripe.PaymentIntent;
      try {
        pi = await this.stripe.paymentIntents.retrieve(
          c.stripe_payment_intent_id,
          // Preview-only expansion; the pinned SDK types don't know the path,
          // and `expand` is a plain string array at runtime.
          { expand: ["latest_charge.allocated_funds.balance"] },
        );
      } catch (err) {
        // 429 / transient / not-found — log and move on. A stale budget is
        // SAFE: the packer under-draws and degrades to the residual, never to
        // an over-transfer. Next sweep retries.
        logger.warn(
          {
            err,
            settlementId: c.id,
            paymentIntentId: c.stripe_payment_intent_id,
          },
          "Allocation sync: paymentIntents.retrieve failed — will retry next sweep",
        );
        continue;
      }

      const charge =
        typeof pi.latest_charge === "string"
          ? null
          : (pi.latest_charge as unknown as ChargeWithAllocatedFunds | null);

      // A charge with no allocated_funds carries none — 0, not NULL. NULL means
      // "we haven't looked"; 0 means "we looked and there is nothing drawable",
      // and only the second stops the sweep re-reading it every cycle.
      const allocatedPence = readAllocatedBalance(charge);

      await pool.query(SYNC_ALLOCATION_STAMP_SQL, [
        c.id,
        allocatedPence + refundAddBackPence,
      ]);
      synced++;
    }

    if (candidates.length > 0) {
      logger.info(
        { checked: candidates.length, synced },
        "Allocation sync sweep complete",
      );
    }
    return { checked: candidates.length, synced };
  }
}

/**
 * Record what a refund drew from a charge's segregated allocation (§3.5).
 *
 * ONE ROW PER SETTLEMENT, HOLDING THE CUMULATIVE TOTAL. Stripe reports
 * `charge.amount_refunded` cumulatively, so a second partial refund arrives as a
 * larger absolute figure rather than an increment — hence GREATEST rather than
 * accumulation. GREATEST rather than a bare assignment because webhook delivery
 * is not ordered: a late redelivery of the FIRST partial must not shrink the
 * budget back. Over-recording can only make us under-draw, which is the safe
 * direction.
 *
 * Exported so the integration test runs the real statement (see the method).
 */
export const RECORD_REFUND_DRAW_SQL = `
  INSERT INTO allocated_draws
    (settlement_id, kind, ref_table, ref_id, gross_pence)
  VALUES ($1, 'refund', 'tab_settlements', $1, $2)
  ON CONFLICT (ref_table, ref_id, kind)
  DO UPDATE SET gross_pence = GREATEST(allocated_draws.gross_pence, EXCLUDED.gross_pence)`;

/**
 * Which settlements `syncAllocations` re-reads (§3.3a + the §0o.2 correction).
 *
 * The NULL arm (first sync) is unconditional; the staleness arm re-syncs ONLY
 * charges with no `allocated_draws` row of any kind. A drawn charge is never
 * re-stamped — Stripe's remaining is net of executed draws, so a re-stamp
 * would subtract every draw twice (see the method header). NOT EXISTS over
 * every kind, deliberately: a refund- or reversal-drawn charge is
 * identity-maintained the same way a transfer-drawn one is.
 *
 * Exported so the integration test executes THIS statement rather than a copy —
 * the drawn-charge exclusion is a predicate only Postgres can evaluate.
 */
export const SYNC_ALLOCATION_CANDIDATES_SQL = `
  SELECT id, stripe_payment_intent_id
    FROM tab_settlements
   WHERE status = 'completed'
     AND stripe_charge_id IS NOT NULL
     AND stripe_payment_intent_id IS NOT NULL
     AND (allocated_pence IS NULL
          OR (allocation_synced_at < now() - make_interval(hours => $1)
              AND NOT EXISTS (SELECT 1 FROM allocated_draws d
                               WHERE d.settlement_id = tab_settlements.id)))
   ORDER BY allocation_synced_at ASC NULLS FIRST, settled_at ASC
   LIMIT 200`;

/**
 * The refund add-back the stamp restores (§0o.2): refund-kind draws only, read
 * BEFORE the Stripe retrieve. See the method header for why both halves of
 * that sentence are load-bearing.
 */
export const SYNC_ALLOCATION_REFUND_SNAPSHOT_SQL = `
  SELECT COALESCE(SUM(gross_pence), 0)::int AS refund_pence
    FROM allocated_draws
   WHERE settlement_id = $1 AND kind = 'refund'`;

/** $2 is `Stripe remaining + the refund add-back`, never the raw remaining. */
export const SYNC_ALLOCATION_STAMP_SQL = `
  UPDATE tab_settlements
     SET allocated_pence = $2, allocation_synced_at = now()
   WHERE id = $1`;

export const settlementService = new SettlementService();
