import type { FastifyInstance } from 'fastify'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Subscription-nudge + spend-conversion flow
//
// POST /nudge/shown                         — Mark nudge shown for reader/writer/month
// POST /subscriptions/:writerId/convert     — Subscribe via spend conversion
// =============================================================================

export async function articleSubscriptionConvertRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /nudge/shown — mark subscription nudge as shown for reader/writer/month
  // ---------------------------------------------------------------------------

  app.post<{ Body: { writerId: string } }>(
    '/nudge/shown',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.body as { writerId: string }

      if (!writerId) {
        return reply.status(400).send({ error: 'writerId is required' })
      }

      await pool.query(
        `INSERT INTO subscription_nudge_log (reader_id, writer_id, month)
         VALUES ($1, $2, date_trunc('month', now())::date)
         ON CONFLICT (reader_id, writer_id, month) DO NOTHING`,
        [readerId, writerId]
      )

      return reply.status(204).send()
    }
  )

  // ---------------------------------------------------------------------------
  // POST /subscriptions/:writerId/convert — subscribe via spend conversion
  //
  // Converts the reader's per-article spend on this writer for the current
  // month into a subscription. Credits back the spend to the reader's tab.
  // The subscription period ends at the end of the current calendar month,
  // then renews at full monthly intervals.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { writerId: string } }>(
    '/subscriptions/:writerId/convert',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.params

      if (readerId === writerId) {
        return reply.status(400).send({ error: 'Cannot subscribe to yourself' })
      }

      return withTransaction(async (client) => {
        // Get writer's subscription price
        const writerResult = await client.query<{
          subscription_price_pence: number
          nostr_pubkey: string
        }>(
          `SELECT subscription_price_pence, nostr_pubkey FROM accounts WHERE id = $1 AND status = 'active'`,
          [writerId]
        )
        if (writerResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Writer not found' })
        }

        const subPrice = writerResult.rows[0].subscription_price_pence

        // Check not already subscribed
        const existingSub = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM subscriptions WHERE reader_id = $1 AND writer_id = $2`,
          [readerId, writerId]
        )
        if (existingSub.rows.length > 0 && existingSub.rows[0].status === 'active') {
          return reply.status(409).send({ error: 'Already subscribed' })
        }

        // Calculate current month spend on this writer
        const spendResult = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount_pence), 0) AS total
           FROM read_events
           WHERE reader_id = $1 AND writer_id = $2
             AND read_at >= date_trunc('month', now())`,
          [readerId, writerId]
        )
        const spendPence = parseInt(spendResult.rows[0].total, 10)

        if (spendPence < Math.floor(subPrice * 0.7)) {
          return reply.status(400).send({ error: 'Spend threshold not met for conversion' })
        }

        // Period ends at end of current calendar month
        const now = new Date()
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1) // first of next month

        // Create or reactivate subscription
        let subscriptionId: string
        if (existingSub.rows.length > 0) {
          await client.query(
            `UPDATE subscriptions
             SET status = 'active', auto_renew = TRUE, cancelled_at = NULL,
                 current_period_start = $1, current_period_end = $2,
                 price_pence = $3, subscription_period = 'monthly', updated_at = now()
             WHERE id = $4`,
            [now, periodEnd, subPrice, existingSub.rows[0].id]
          )
          subscriptionId = existingSub.rows[0].id
        } else {
          const subResult = await client.query<{ id: string }>(
            `INSERT INTO subscriptions (reader_id, writer_id, status, price_pence, subscription_period, current_period_start, current_period_end, auto_renew)
             VALUES ($1, $2, 'active', $3, 'monthly', $4, $5, TRUE)
             RETURNING id`,
            [readerId, writerId, subPrice, now, periodEnd]
          )
          subscriptionId = subResult.rows[0].id
        }

        // Credit back the reader's spend to their tab
        if (spendPence > 0) {
          await client.query(
            `UPDATE reading_tabs SET balance_pence = balance_pence - $1, updated_at = now()
             WHERE reader_id = $2 AND status = 'open'`,
            [spendPence, readerId]
          )
        }

        // Log the subscription charge event
        await client.query(
          `INSERT INTO subscription_events (subscription_id, event_type, reader_id, writer_id, amount_pence, description)
           VALUES ($1, 'subscription_charge', $2, $3, $4, 'Subscription via spend conversion (first month)')`,
          [subscriptionId, readerId, writerId, spendPence > subPrice ? 0 : subPrice - spendPence]
        )

        // Mark the nudge as converted
        await client.query(
          `UPDATE subscription_nudge_log SET converted = TRUE
           WHERE reader_id = $1 AND writer_id = $2 AND month = date_trunc('month', now())::date`,
          [readerId, writerId]
        )

        // Send notification (non-blocking)
        pool.query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
           VALUES ($1, $2, 'new_subscriber')
           ON CONFLICT DO NOTHING`,
          [writerId, readerId]
        ).catch((err) => logger.warn({ err }, 'Failed to insert new_subscriber notification'))

        return reply.status(200).send({ subscriptionId, status: 'active', converted: true })
      })
    }
  )
}
