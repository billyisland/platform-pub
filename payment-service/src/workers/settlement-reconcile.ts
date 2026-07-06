import { settlementService } from "../services/settlement.js";
import logger from "../lib/logger.js";

// =============================================================================
// Settlement Reconciliation Worker
//
// Backstop for missed Stripe `payment_intent.succeeded` webhooks. That webhook
// is the ONLY thing that runs confirmSettlement — which debits the tab, posts
// the reader ledger credit, and advances reads to platform_settled. A settlement
// is flipped to 'completed' the moment the PaymentIntent is created (the card is
// charged), so a single dropped webhook leaves the reader CHARGED with no tab/
// ledger movement and reads stuck 'accrued' indefinitely, with no error. This is
// the settlement-side twin of the KYC reconcile worker.
//
// Two sweeps per cycle (Wave-5 P3): reconcileSettlements covers 'completed'-but-
// unconfirmed rows (the missed-webhook case above); resumePendingSettlements
// covers 'pending'-stuck rows (a settlement that crashed after reserving but
// before/during the Stripe call). Previously the latter ran ONLY at process
// startup, so a transient-error-stuck pending settlement waited for a restart —
// unlike payouts, which resume every cycle. Running it here gives settlements the
// same periodic self-heal.
//
// Runs 3×/day, on the same offset cadence as the KYC sweep (00:15, 08:15,
// 16:15 UTC — staggered from the 02:30 payout cycle and the :30 KYC sweep).
// =============================================================================

const RUN_HOURS_UTC = [0, 8, 16];
const RUN_MINUTE_UTC = 15;

function msUntilNextRun(): number {
  const now = new Date();
  let soonest = Infinity;
  for (const hour of RUN_HOURS_UTC) {
    const next = new Date();
    next.setUTCHours(hour, RUN_MINUTE_UTC, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    soonest = Math.min(soonest, next.getTime() - now.getTime());
  }
  return soonest;
}

export function startSettlementReconcileWorker(): void {
  const scheduleNext = () => {
    const delay = msUntilNextRun();
    logger.info(
      {
        nextRunInMs: delay,
        nextRunAt: new Date(Date.now() + delay).toISOString(),
      },
      "Settlement reconcile worker scheduled",
    );

    setTimeout(async () => {
      // Resume pending-stuck settlements first (retry the Stripe call for a
      // crashed reserve), then reconcile completed-but-unconfirmed rows. Isolated
      // try/catch so one failing sweep never skips the other or the reschedule.
      try {
        await settlementService.resumePendingSettlements();
      } catch (err) {
        logger.error({ err }, "Settlement resume sweep failed");
      }
      try {
        const result = await settlementService.reconcileSettlements();
        logger.info(result, "Settlement reconcile sweep complete");
      } catch (err) {
        logger.error({ err }, "Settlement reconcile sweep failed");
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
}
