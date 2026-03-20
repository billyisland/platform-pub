import { payoutService } from '../services/payout.js'
import logger from '../lib/logger.js'

// =============================================================================
// Daily Payout Worker
//
// Runs once per day. Calls payoutService.runPayoutCycle() which finds all
// writers with available balance >= £20 and initiates Stripe Connect transfers.
//
// Can also be triggered via the internal /payout-cycle HTTP route (e.g. for
// manual runs or integration tests).
//
// Schedule: runs at 02:00 UTC daily — well outside peak traffic.
// =============================================================================

const PAYOUT_HOUR_UTC = 2
const PAYOUT_MINUTE_UTC = 0

function msUntilNextRun(): number {
  const now = new Date()
  const next = new Date()
  next.setUTCHours(PAYOUT_HOUR_UTC, PAYOUT_MINUTE_UTC, 0, 0)
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

export function startPayoutWorker(): void {
  const scheduleNext = () => {
    const delay = msUntilNextRun()
    logger.info(
      { nextRunInMs: delay, nextRunAt: new Date(Date.now() + delay).toISOString() },
      'Payout worker scheduled'
    )

    setTimeout(async () => {
      try {
        logger.info('Payout cycle starting')
        const result = await payoutService.runPayoutCycle()
        logger.info(result, 'Payout cycle complete')
      } catch (err) {
        logger.error({ err }, 'Payout cycle failed')
      } finally {
        scheduleNext()
      }
    }, delay)
  }

  scheduleNext()
}
