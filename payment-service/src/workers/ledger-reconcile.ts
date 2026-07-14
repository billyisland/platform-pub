import { runLedgerReconcileAndEnforce } from "../services/reconcile-ledger.js";
import logger from "../lib/logger.js";

// =============================================================================
// Ledger Reconciliation Worker (PAYMENTS ADR §1.2)
//
// Runs the reader-tab ledger-parity checks (services/reconcile-ledger.ts) on a
// schedule with a DEFINED mismatch response: on any divergence it ALERTS (a
// fatal-level structured log) and HALTS PAYOUTS (a durable platform_config flag
// the three payout cycles refuse to run past). This is the scheduled form of
// scripts/reconcile-ledger.sql's "must always be empty" checks — promoting the
// same-signed-delta invariant from a manual script to an enforced control.
//
// Cadence: 3×/day at 01:45, 09:45, 17:45 UTC. The 01:45 run sits 45 min BEFORE
// the 02:30 payout cycle, so a divergence halts that morning's payout; the other
// two catch intra-day drift. Staggered off the payout (02:30), settlement
// reconcile (:15), and KYC (:30) sweeps.
// =============================================================================

const RUN_HOURS_UTC = [1, 9, 17];
const RUN_MINUTE_UTC = 45;

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

export function startLedgerReconcileWorker(): void {
  const scheduleNext = () => {
    const delay = msUntilNextRun();
    logger.info(
      {
        nextRunInMs: delay,
        nextRunAt: new Date(Date.now() + delay).toISOString(),
      },
      "Ledger reconcile worker scheduled",
    );

    setTimeout(async () => {
      try {
        const result = await runLedgerReconcileAndEnforce();
        // The fatal alert + halt is emitted inside runLedgerReconcileAndEnforce
        // on mismatch; here we only note the sweep ran.
        logger.info(
          { ok: result.ok, violations: result.violations.length },
          "Ledger reconcile sweep complete",
        );
      } catch (err) {
        logger.error({ err }, "Ledger reconcile sweep failed");
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
}
