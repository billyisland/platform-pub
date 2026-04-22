import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { signSubscriptionEvent } from '../lib/nostr-publisher.js'
import { enqueueRelayPublish } from '@platform-pub/shared/lib/relay-outbox.js'
import {
  sendSubscriptionRenewedEmail,
  sendSubscriptionExpiryWarningEmail,
} from '@platform-pub/shared/lib/subscription-emails.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { logSubscriptionCharge } from '../routes/subscriptions/index.js'

// =============================================================================
// Subscription renewal and expiry — runs hourly from gateway/index.ts under
// an advisory lock.
//
// 1. Auto-renew: active subscriptions past period end with auto_renew = true
//    → charge reader, roll period forward, log events, publish Nostr attestation
// 2. Expire: active/cancelled subscriptions past period end with auto_renew = false
//    → set status to 'expired'
// 3. Expiry warnings: send email 3 days before period end for non-auto-renewing
// =============================================================================

export async function expireAndRenewSubscriptions(): Promise<number> {
  let processed = 0

  // --- Phase 1: Auto-renew subscriptions ---
  const renewable = await pool.query<{
    id: string
    reader_id: string
    writer_id: string
    price_pence: number
    current_period_end: Date
    reader_pubkey: string
    writer_pubkey: string
    subscription_period: string
    offer_periods_remaining: number | null
    writer_standard_price: number
  }>(
    `SELECT s.id, s.reader_id, s.writer_id, s.price_pence,
            s.current_period_end,
            r.nostr_pubkey AS reader_pubkey,
            w.nostr_pubkey AS writer_pubkey,
            COALESCE(s.subscription_period, 'monthly') AS subscription_period,
            s.offer_periods_remaining,
            w.subscription_price_pence AS writer_standard_price
     FROM subscriptions s
     JOIN accounts r ON r.id = s.reader_id
     JOIN accounts w ON w.id = s.writer_id
     WHERE s.status = 'active'
       AND s.auto_renew = TRUE
       AND s.current_period_end < now()`
  )

  for (const sub of renewable.rows) {
    try {
      const periodDays = sub.subscription_period === 'annual' ? 365 : 30
      const newPeriodStart = sub.current_period_end
      const newPeriodEnd = new Date(newPeriodStart.getTime() + periodDays * 24 * 60 * 60 * 1000)

      // Check if the offer period is expiring — revert to standard price
      let renewalPrice = sub.price_pence
      const offerExpiring = sub.offer_periods_remaining !== null && sub.offer_periods_remaining <= 1

      if (offerExpiring) {
        renewalPrice = sub.subscription_period === 'annual'
          ? Math.round(sub.writer_standard_price * 12 * 0.85)
          : sub.writer_standard_price
      }

      await withTransaction(async (client) => {
        await client.query(
          `UPDATE accounts SET free_allowance_remaining_pence = free_allowance_remaining_pence - $1, updated_at = now() WHERE id = $2`,
          [renewalPrice, sub.reader_id]
        )

        if (offerExpiring) {
          await client.query(
            `UPDATE subscriptions
             SET current_period_start = $1, current_period_end = $2,
                 price_pence = $3, offer_id = NULL, offer_periods_remaining = NULL, updated_at = now()
             WHERE id = $4`,
            [newPeriodStart, newPeriodEnd, renewalPrice, sub.id]
          )
        } else if (sub.offer_periods_remaining !== null) {
          await client.query(
            `UPDATE subscriptions
             SET current_period_start = $1, current_period_end = $2,
                 offer_periods_remaining = offer_periods_remaining - 1, updated_at = now()
             WHERE id = $3`,
            [newPeriodStart, newPeriodEnd, sub.id]
          )
        } else {
          await client.query(
            `UPDATE subscriptions
             SET current_period_start = $1, current_period_end = $2, updated_at = now()
             WHERE id = $3`,
            [newPeriodStart, newPeriodEnd, sub.id]
          )
        }

        await logSubscriptionCharge(client, sub.id, sub.reader_id, sub.writer_id, renewalPrice, newPeriodStart, newPeriodEnd)

        const renewalEvent = signSubscriptionEvent({
          subscriptionId: sub.id,
          readerPubkey: sub.reader_pubkey,
          writerPubkey: sub.writer_pubkey,
          status: 'active',
          pricePence: renewalPrice,
          periodStart: newPeriodStart,
          periodEnd: newPeriodEnd,
        })
        await client.query(
          `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
          [renewalEvent.id, sub.id]
        )
        await enqueueRelayPublish(client, {
          entityType: 'subscription',
          entityId: sub.id,
          signedEvent: renewalEvent,
        })
      })

      sendSubscriptionRenewedEmail(sub.reader_id, sub.writer_id, renewalPrice, newPeriodEnd).catch(err =>
        logger.warn({ err, subscriptionId: sub.id }, 'Renewal email failed')
      )

      logger.info({ subscriptionId: sub.id, readerId: sub.reader_id, writerId: sub.writer_id }, 'Subscription renewed')
      processed++
    } catch (err) {
      // Renewal failed (e.g. DB error) — expire the subscription
      logger.error({ err, subscriptionId: sub.id }, 'Subscription renewal failed, expiring')
      await pool.query(
        `UPDATE subscriptions SET status = 'expired', auto_renew = FALSE, updated_at = now() WHERE id = $1`,
        [sub.id]
      ).catch(expErr => logger.error({ err: expErr, subscriptionId: sub.id }, 'Failed to expire after renewal failure'))
      processed++
    }
  }

  // --- Phase 2: Expire non-renewing subscriptions past period end ---
  const expired = await pool.query(
    `UPDATE subscriptions
     SET status = 'expired', updated_at = now()
     WHERE status IN ('active', 'cancelled')
       AND auto_renew = FALSE
       AND current_period_end < now()
     RETURNING id`
  )

  const expiredCount = expired.rowCount ?? 0
  if (expiredCount > 0) {
    logger.info({ count: expiredCount }, 'Expired non-renewing subscriptions')
    processed += expiredCount
  }

  // --- Phase 3: Send expiry warning emails (3 days before period end) ---
  const expiringSoon = await pool.query<{
    id: string
    reader_id: string
    writer_id: string
    current_period_end: Date
  }>(
    `SELECT s.id, s.reader_id, s.writer_id, s.current_period_end
     FROM subscriptions s
     WHERE s.status IN ('active', 'cancelled')
       AND s.auto_renew = FALSE
       AND s.current_period_end BETWEEN now() AND now() + INTERVAL '3 days'
       AND NOT EXISTS (
         SELECT 1 FROM subscription_events se
         WHERE se.subscription_id = s.id
           AND se.event_type = 'expiry_warning_sent'
           AND se.created_at > now() - INTERVAL '4 days'
       )`
  )

  for (const sub of expiringSoon.rows) {
    sendSubscriptionExpiryWarningEmail(sub.reader_id, sub.writer_id, sub.current_period_end).catch(err =>
      logger.warn({ err, subscriptionId: sub.id }, 'Expiry warning email failed')
    )
    // Await: a missing insert after a successful email send means the next
    // cycle re-sends.
    await pool.query(
      `INSERT INTO subscription_events (subscription_id, event_type, reader_id, writer_id, amount_pence, description)
       VALUES ($1, 'expiry_warning_sent', $2, $3, 0, 'Expiry warning sent')`,
      [sub.id, sub.reader_id, sub.writer_id]
    )
  }

  return processed
}
