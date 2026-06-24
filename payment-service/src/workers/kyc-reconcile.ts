import { payoutService } from "../services/payout.js";
import logger from "../lib/logger.js";

// =============================================================================
// KYC Reconciliation Worker
//
// Backstop for missed Stripe `account.updated` webhooks. The webhook is the
// only thing that flips stripe_connect_kyc_complete = TRUE, and at-least-once
// delivery is not always-once — a single dropped event strands a writer's
// earnings indefinitely with no error. This worker re-reads Connect accounts
// that are owed money but not yet marked complete, and flips any Stripe now
// reports as payable (same gate as the webhook, via isConnectPayable).
//
// Runs 3×/day, offset from the 02:30 payout cycle so a flip lands BEFORE the
// next payout run rather than just after it.
// =============================================================================

const RUN_HOURS_UTC = [1, 9, 17];
const RUN_MINUTE_UTC = 30;

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

export function startKycReconcileWorker(): void {
  const scheduleNext = () => {
    const delay = msUntilNextRun();
    logger.info(
      {
        nextRunInMs: delay,
        nextRunAt: new Date(Date.now() + delay).toISOString(),
      },
      "KYC reconcile worker scheduled",
    );

    setTimeout(async () => {
      try {
        const result = await payoutService.reconcileConnectKyc();
        logger.info(result, "KYC reconcile sweep complete");
      } catch (err) {
        logger.error({ err }, "KYC reconcile sweep failed");
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
}
