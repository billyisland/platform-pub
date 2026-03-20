import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Subscription Routes
//
// POST   /subscriptions/:writerId          — subscribe to a writer
// DELETE /subscriptions/:writerId          — cancel subscription
// GET    /subscriptions/mine               — list my active subscriptions
// GET    /subscriptions/check/:writerId    — check if I'm subscribed to a writer
// GET    /subscribers                      — list my subscribers (writer view)
// PATCH  /settings/subscription-price      — set my subscription price
// =============================================================================

export async function subscriptionRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /subscriptions/:writerId — subscribe to a writer
  //
  // Charges immediately for the first month. Creates the subscription record
  // and logs a subscription_charge (debit) and subscription_earning (credit).
  // ---------------------------------------------------------------------------

  app.post<{ Params: { writerId: string } }>(
    '/subscriptions/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.params

      if (readerId === writerId) {
        return reply.status(400).send({ error: 'Cannot subscribe to yourself' })
      }

      return withTransaction(async (client) => {
        // Check writer exists and get their subscription price
        const writerResult = await client.query<{
          id: string
          subscription_price_pence: number
          display_name: string | null
          username: string
        }>(
          `SELECT id, subscription_price_pence, display_name, username
           FROM accounts WHERE id = $1 AND status = 'active'`,
          [writerId]
        )

        if (writerResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Writer not found' })
        }

        const writer = writerResult.rows[0]
        const pricePence = writer.subscription_price_pence

        // Check for existing active/cancelled subscription
        const existing = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM subscriptions
           WHERE reader_id = $1 AND writer_id = $2 AND status IN ('active', 'cancelled')`,
          [readerId, writerId]
        )

        if (existing.rows.length > 0) {
          const sub = existing.rows[0]
          if (sub.status === 'active') {
            return reply.status(409).send({ error: 'Already subscribed' })
          }
          // Re-activate a cancelled subscription
          const now = new Date()
          const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

          await client.query(
            `UPDATE subscriptions
             SET status = 'active', cancelled_at = NULL,
                 current_period_start = $1, current_period_end = $2,
                 price_pence = $3, updated_at = now()
             WHERE id = $4`,
            [now, periodEnd, pricePence, sub.id]
          )

          // Log the charge and earning
          await logSubscriptionCharge(client, sub.id, readerId, writerId, pricePence, now, periodEnd)

          logger.info({ readerId, writerId, subscriptionId: sub.id }, 'Subscription reactivated')
          return reply.status(200).send({ subscriptionId: sub.id, status: 'active', pricePence })
        }

        // Create new subscription
        const now = new Date()
        const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

        const subResult = await client.query<{ id: string }>(
          `INSERT INTO subscriptions (reader_id, writer_id, price_pence, status,
             current_period_start, current_period_end)
           VALUES ($1, $2, $3, 'active', $4, $5)
           RETURNING id`,
          [readerId, writerId, pricePence, now, periodEnd]
        )

        const subscriptionId = subResult.rows[0].id

        // Log the charge and earning
        await logSubscriptionCharge(client, subscriptionId, readerId, writerId, pricePence, now, periodEnd)

        logger.info({ readerId, writerId, subscriptionId, pricePence }, 'Subscription created')

        return reply.status(201).send({
          subscriptionId,
          status: 'active',
          pricePence,
          currentPeriodEnd: periodEnd.toISOString(),
          writerName: writer.display_name ?? writer.username,
        })
      })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /subscriptions/:writerId — cancel subscription
  //
  // Sets status to 'cancelled'. Access continues until current_period_end.
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { writerId: string } }>(
    '/subscriptions/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.params

      const result = await pool.query<{ id: string; current_period_end: Date }>(
        `UPDATE subscriptions
         SET status = 'cancelled', cancelled_at = now(), updated_at = now()
         WHERE reader_id = $1 AND writer_id = $2 AND status = 'active'
         RETURNING id, current_period_end`,
        [readerId, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'No active subscription found' })
      }

      const sub = result.rows[0]
      logger.info({ readerId, writerId, subscriptionId: sub.id }, 'Subscription cancelled')

      return reply.status(200).send({
        subscriptionId: sub.id,
        status: 'cancelled',
        accessUntil: sub.current_period_end.toISOString(),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /subscriptions/mine — list my active/cancelled subscriptions
  // ---------------------------------------------------------------------------

  app.get(
    '/subscriptions/mine',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!

      const { rows } = await pool.query<{
        id: string
        writer_id: string
        writer_username: string
        writer_display_name: string | null
        writer_avatar: string | null
        price_pence: number
        status: string
        current_period_end: Date
        started_at: Date
        cancelled_at: Date | null
      }>(
        `SELECT s.id, s.writer_id, w.username AS writer_username,
                w.display_name AS writer_display_name,
                w.avatar_blossom_url AS writer_avatar,
                s.price_pence, s.status, s.current_period_end,
                s.started_at, s.cancelled_at
         FROM subscriptions s
         JOIN accounts w ON w.id = s.writer_id
         WHERE s.reader_id = $1 AND s.status IN ('active', 'cancelled')
         ORDER BY s.started_at DESC`,
        [readerId]
      )

      return reply.status(200).send({
        subscriptions: rows.map(s => ({
          id: s.id,
          writerId: s.writer_id,
          writerUsername: s.writer_username,
          writerDisplayName: s.writer_display_name,
          writerAvatar: s.writer_avatar,
          pricePence: s.price_pence,
          status: s.status,
          currentPeriodEnd: s.current_period_end.toISOString(),
          startedAt: s.started_at.toISOString(),
          cancelledAt: s.cancelled_at?.toISOString() ?? null,
        })),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /subscriptions/check/:writerId — check subscription status
  //
  // Returns whether the current user has an active (or cancelled-but-valid)
  // subscription to the given writer.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { writerId: string } }>(
    '/subscriptions/check/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.params

      // Own content is always free
      if (readerId === writerId) {
        return reply.status(200).send({ subscribed: false, ownContent: true })
      }

      const { rows } = await pool.query<{
        id: string
        status: string
        current_period_end: Date
        price_pence: number
      }>(
        `SELECT id, status, current_period_end, price_pence
         FROM subscriptions
         WHERE reader_id = $1 AND writer_id = $2
           AND status IN ('active', 'cancelled')
           AND current_period_end > now()`,
        [readerId, writerId]
      )

      if (rows.length === 0) {
        return reply.status(200).send({ subscribed: false })
      }

      const sub = rows[0]
      return reply.status(200).send({
        subscribed: true,
        subscriptionId: sub.id,
        status: sub.status,
        currentPeriodEnd: sub.current_period_end.toISOString(),
        pricePence: sub.price_pence,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /subscribers — list my subscribers (writer view)
  //
  // Shows active and recently-cancelled subscribers with engagement data.
  // ---------------------------------------------------------------------------

  app.get(
    '/subscribers',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!

      const { rows } = await pool.query<{
        subscription_id: string
        reader_id: string
        reader_username: string
        reader_display_name: string | null
        reader_avatar: string | null
        price_pence: number
        status: string
        started_at: Date
        current_period_end: Date
        cancelled_at: Date | null
        articles_read: string
        total_article_value_pence: string
      }>(
        `SELECT s.id AS subscription_id, s.reader_id,
                r.username AS reader_username,
                r.display_name AS reader_display_name,
                r.avatar_blossom_url AS reader_avatar,
                s.price_pence, s.status, s.started_at,
                s.current_period_end, s.cancelled_at,
                COUNT(se.id) FILTER (WHERE se.event_type = 'subscription_read') AS articles_read,
                COALESCE(SUM(
                  CASE WHEN se.event_type = 'subscription_read' AND se.article_id IS NOT NULL
                  THEN (SELECT price_pence FROM articles WHERE id = se.article_id)
                  ELSE 0 END
                ), 0) AS total_article_value_pence
         FROM subscriptions s
         JOIN accounts r ON r.id = s.reader_id
         LEFT JOIN subscription_events se ON se.subscription_id = s.id
         WHERE s.writer_id = $1 AND s.status IN ('active', 'cancelled')
         GROUP BY s.id, s.reader_id, r.username, r.display_name,
                  r.avatar_blossom_url, s.price_pence, s.status,
                  s.started_at, s.current_period_end, s.cancelled_at
         ORDER BY s.started_at DESC`,
        [writerId]
      )

      const subscribers = rows.map(s => {
        const articlesRead = parseInt(s.articles_read, 10)
        const totalArticleValue = parseInt(s.total_article_value_pence, 10)
        const gettingMoneysworth = totalArticleValue >= s.price_pence

        return {
          subscriptionId: s.subscription_id,
          readerId: s.reader_id,
          readerUsername: s.reader_username,
          readerDisplayName: s.reader_display_name,
          readerAvatar: s.reader_avatar,
          pricePence: s.price_pence,
          status: s.status,
          startedAt: s.started_at.toISOString(),
          currentPeriodEnd: s.current_period_end.toISOString(),
          cancelledAt: s.cancelled_at?.toISOString() ?? null,
          articlesRead,
          totalArticleValuePence: totalArticleValue,
          gettingMoneysworth,
        }
      })

      return reply.status(200).send({ subscribers })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /settings/subscription-price — set writer's subscription price
  // ---------------------------------------------------------------------------

  const PriceSchema = z.object({
    pricePence: z.number().int().min(100).max(10000), // £1 to £100
  })

  app.patch(
    '/settings/subscription-price',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = PriceSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const accountId = req.session!.sub!

      await pool.query(
        `UPDATE accounts SET subscription_price_pence = $1, updated_at = now() WHERE id = $2`,
        [parsed.data.pricePence, accountId]
      )

      logger.info({ accountId, pricePence: parsed.data.pricePence }, 'Subscription price updated')

      return reply.status(200).send({ ok: true, pricePence: parsed.data.pricePence })
    }
  )
}

// =============================================================================
// Helper — log subscription charge and earning events
// =============================================================================

async function logSubscriptionCharge(
  client: any,
  subscriptionId: string,
  readerId: string,
  writerId: string,
  pricePence: number,
  periodStart: Date,
  periodEnd: Date,
) {
  const platformFeePence = Math.round(pricePence * 0.08)
  const writerEarningPence = pricePence - platformFeePence

  // Debit event for reader
  await client.query(
    `INSERT INTO subscription_events
       (subscription_id, event_type, reader_id, writer_id, amount_pence, period_start, period_end, description)
     VALUES ($1, 'subscription_charge', $2, $3, $4, $5, $6, $7)`,
    [subscriptionId, readerId, writerId, pricePence, periodStart, periodEnd,
     `Monthly subscription`]
  )

  // Credit event for writer (after platform fee)
  await client.query(
    `INSERT INTO subscription_events
       (subscription_id, event_type, reader_id, writer_id, amount_pence, period_start, period_end, description)
     VALUES ($1, 'subscription_earning', $2, $3, $4, $5, $6, $7)`,
    [subscriptionId, readerId, writerId, writerEarningPence, periodStart, periodEnd,
     `Subscriber income (after 8% fee)`]
  )
}
