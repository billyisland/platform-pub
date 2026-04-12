import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { publishSubscriptionEvent } from '../lib/nostr-publisher.js'
import {
  sendSubscriptionRenewedEmail,
  sendSubscriptionCancelledEmail,
  sendSubscriptionExpiryWarningEmail,
  sendNewSubscriberEmail,
} from '../../shared/src/lib/subscription-emails.js'
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

  app.post<{ Params: { writerId: string }; Body: { period?: string; offerCode?: string } }>(
    '/subscriptions/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.params
      const body = req.body as { period?: string; offerCode?: string }
      const period = body?.period === 'annual' ? 'annual' : 'monthly'
      const offerCode = body?.offerCode

      if (readerId === writerId) {
        return reply.status(400).send({ error: 'Cannot subscribe to yourself' })
      }

      return withTransaction(async (client) => {
        // Check writer exists and get their subscription price
        const writerResult = await client.query<{
          id: string
          subscription_price_pence: number
          annual_discount_pct: number
          display_name: string | null
          username: string
          nostr_pubkey: string
        }>(
          `SELECT id, subscription_price_pence, annual_discount_pct, display_name, username, nostr_pubkey
           FROM accounts WHERE id = $1 AND status = 'active'`,
          [writerId]
        )

        if (writerResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Writer not found' })
        }

        const writer = writerResult.rows[0]
        const monthlyPrice = writer.subscription_price_pence
        let pricePence = period === 'annual'
          ? Math.round(monthlyPrice * 12 * (1 - writer.annual_discount_pct / 100))
          : monthlyPrice

        // Validate and apply offer if provided
        let offerId: string | null = null
        let offerPeriodsRemaining: number | null = null

        if (offerCode) {
          const offerResult = await client.query<{
            id: string; mode: string; discount_pct: number; duration_months: number | null
            max_redemptions: number | null; redemption_count: number; expires_at: Date | null
            recipient_id: string | null
          }>(
            `SELECT id, mode, discount_pct, duration_months, max_redemptions,
                    redemption_count, expires_at, recipient_id
             FROM subscription_offers
             WHERE code = $1 AND writer_id = $2 AND revoked_at IS NULL`,
            [offerCode, writerId]
          )

          if (offerResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Offer not found or no longer available' })
          }

          const offer = offerResult.rows[0]

          if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
            return reply.status(410).send({ error: 'This offer has expired' })
          }
          if (offer.max_redemptions !== null && offer.redemption_count >= offer.max_redemptions) {
            return reply.status(410).send({ error: 'This offer has been fully redeemed' })
          }
          if (offer.mode === 'grant' && offer.recipient_id !== readerId) {
            return reply.status(403).send({ error: 'This offer is not available to you' })
          }

          pricePence = Math.round(pricePence * (1 - offer.discount_pct / 100))
          offerId = offer.id
          offerPeriodsRemaining = offer.duration_months ?? null

          // Increment redemption count atomically
          await client.query(
            `UPDATE subscription_offers SET redemption_count = redemption_count + 1 WHERE id = $1`,
            [offer.id]
          )
        }

        // Check for existing subscription (any status — unique constraint on reader+writer)
        const existing = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM subscriptions
           WHERE reader_id = $1 AND writer_id = $2`,
          [readerId, writerId]
        )

        if (existing.rows.length > 0) {
          const sub = existing.rows[0]
          if (sub.status === 'active') {
            return reply.status(409).send({ error: 'Already subscribed' })
          }
          // Re-activate a cancelled or expired subscription
          const now = new Date()
          const periodDays = period === 'annual' ? 365 : 30
          const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000)

          await client.query(
            `UPDATE subscriptions
             SET status = 'active', auto_renew = TRUE, cancelled_at = NULL,
                 current_period_start = $1, current_period_end = $2,
                 price_pence = $3, subscription_period = $5,
                 offer_id = $6, offer_periods_remaining = $7, updated_at = now()
             WHERE id = $4`,
            [now, periodEnd, pricePence, sub.id, period, offerId, offerPeriodsRemaining]
          )

          // Deduct from free allowance (can go negative)
          await client.query(
            `UPDATE accounts SET free_allowance_remaining_pence = free_allowance_remaining_pence - $1, updated_at = now() WHERE id = $2`,
            [pricePence, readerId]
          )

          // Log the charge and earning
          await logSubscriptionCharge(client, sub.id, readerId, writerId, pricePence, now, periodEnd)

          logger.info({ readerId, writerId, subscriptionId: sub.id }, 'Subscription reactivated')

          pool.query(
            `INSERT INTO notifications (recipient_id, actor_id, type)
             VALUES ($1, $2, 'new_subscriber')
             ON CONFLICT DO NOTHING`,
            [writerId, readerId]
          ).catch((err) => logger.warn({ err }, 'Failed to insert new_subscriber notification'))

          // Publish subscription event asynchronously — non-blocking
          const readerPubkey = req.session!.pubkey
          publishSubscriptionEvent({
            subscriptionId: sub.id,
            readerPubkey,
            writerPubkey: writer.nostr_pubkey,
            status: 'active',
            pricePence,
            periodStart: now,
            periodEnd,
          }).then(nostrEventId =>
            pool.query(
              `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
              [nostrEventId, sub.id]
            )
          ).catch(err =>
            logger.error({ err, subscriptionId: sub.id }, 'Subscription reactivation Nostr event failed')
          )

          // Notify writer of new subscriber — non-blocking
          sendNewSubscriberEmail(writerId, readerId, pricePence).catch(err =>
            logger.warn({ err, subscriptionId: sub.id }, 'New subscriber email failed')
          )

          return reply.status(200).send({ subscriptionId: sub.id, status: 'active', pricePence })
        }

        // Create new subscription
        const now = new Date()
        const periodDays = period === 'annual' ? 365 : 30
        const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000)

        const subResult = await client.query<{ id: string }>(
          `INSERT INTO subscriptions (reader_id, writer_id, price_pence, status,
             current_period_start, current_period_end, subscription_period,
             offer_id, offer_periods_remaining)
           VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8)
           RETURNING id`,
          [readerId, writerId, pricePence, now, periodEnd, period, offerId, offerPeriodsRemaining]
        )

        const subscriptionId = subResult.rows[0].id

        // Deduct from free allowance (can go negative — same as article reads)
        await client.query(
          `UPDATE accounts SET free_allowance_remaining_pence = free_allowance_remaining_pence - $1, updated_at = now() WHERE id = $2`,
          [pricePence, readerId]
        )

        // Log the charge and earning
        await logSubscriptionCharge(client, subscriptionId, readerId, writerId, pricePence, now, periodEnd)

        logger.info({ readerId, writerId, subscriptionId, pricePence }, 'Subscription created')

        pool.query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
           VALUES ($1, $2, 'new_subscriber')
           ON CONFLICT DO NOTHING`,
          [writerId, readerId]
        ).catch((err) => logger.warn({ err }, 'Failed to insert new_subscriber notification'))

        // Publish subscription event asynchronously — non-blocking
        const readerPubkey = req.session!.pubkey
        publishSubscriptionEvent({
          subscriptionId,
          readerPubkey,
          writerPubkey: writer.nostr_pubkey,
          status: 'active',
          pricePence,
          periodStart: now,
          periodEnd,
        }).then(nostrEventId =>
          pool.query(
            `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
            [nostrEventId, subscriptionId]
          )
        ).catch(err =>
          logger.error({ err, subscriptionId }, 'Subscription create Nostr event failed')
        )

        // Notify writer of new subscriber — non-blocking
        sendNewSubscriberEmail(writerId, readerId, pricePence).catch(err =>
          logger.warn({ err, subscriptionId }, 'New subscriber email failed')
        )

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
  // Sets auto_renew to false and status to 'cancelled'. Access continues
  // until current_period_end, then the subscription expires instead of renewing.
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { writerId: string } }>(
    '/subscriptions/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.params

      const result = await pool.query<{
        id: string
        current_period_end: Date
        current_period_start: Date
        price_pence: number
        writer_pubkey: string
      }>(
        `UPDATE subscriptions
         SET status = 'cancelled', auto_renew = FALSE, cancelled_at = now(), updated_at = now()
         WHERE reader_id = $1 AND writer_id = $2 AND status = 'active'
         RETURNING id, current_period_end, current_period_start, price_pence,
                   (SELECT nostr_pubkey FROM accounts WHERE id = $2) AS writer_pubkey`,
        [readerId, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'No active subscription found' })
      }

      const sub = result.rows[0]
      logger.info({ readerId, writerId, subscriptionId: sub.id }, 'Subscription cancelled')

      // Publish cancellation event asynchronously — non-blocking
      const readerPubkey = req.session!.pubkey
      publishSubscriptionEvent({
        subscriptionId: sub.id,
        readerPubkey,
        writerPubkey: sub.writer_pubkey,
        status: 'cancelled',
        pricePence: sub.price_pence,
        periodStart: sub.current_period_start,
        periodEnd: sub.current_period_end,
      }).then(nostrEventId =>
        pool.query(
          `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
          [nostrEventId, sub.id]
        )
      ).catch(err =>
        logger.error({ err, subscriptionId: sub.id }, 'Subscription cancel Nostr event failed')
      )

      // Send cancellation email asynchronously
      sendSubscriptionCancelledEmail(readerId, writerId, sub.current_period_end).catch(err =>
        logger.warn({ err, subscriptionId: sub.id }, 'Cancellation email failed')
      )

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
        auto_renew: boolean
        current_period_end: Date
        started_at: Date
        cancelled_at: Date | null
        hidden: boolean
        notify_on_publish: boolean
      }>(
        `SELECT s.id, s.writer_id, w.username AS writer_username,
                w.display_name AS writer_display_name,
                w.avatar_blossom_url AS writer_avatar,
                s.price_pence, s.status, s.auto_renew, s.current_period_end,
                s.started_at, s.cancelled_at, s.hidden, s.notify_on_publish
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
          autoRenew: s.auto_renew,
          currentPeriodEnd: s.current_period_end.toISOString(),
          startedAt: s.started_at.toISOString(),
          cancelledAt: s.cancelled_at?.toISOString() ?? null,
          hidden: s.hidden,
          notifyOnPublish: s.notify_on_publish,
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
  // PATCH /subscriptions/:writerId/visibility — toggle subscription visibility
  //
  // Readers can hide or show individual subscriptions on their public profile.
  // ---------------------------------------------------------------------------

  const VisibilitySchema = z.object({
    hidden: z.boolean(),
  })

  app.patch<{ Params: { writerId: string } }>(
    '/subscriptions/:writerId/visibility',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { writerId } = req.params

      const parsed = VisibilitySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const result = await pool.query(
        `UPDATE subscriptions SET hidden = $1, updated_at = now()
         WHERE reader_id = $2 AND writer_id = $3 AND status IN ('active', 'cancelled')
         RETURNING id`,
        [parsed.data.hidden, readerId, writerId]
      )

      if ((result.rowCount ?? 0) === 0) {
        return reply.status(404).send({ error: 'Subscription not found' })
      }

      return reply.status(200).send({ ok: true, hidden: parsed.data.hidden })
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
        is_comp: boolean
        auto_renew: boolean
        subscription_period: string
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
                s.price_pence, s.status, s.is_comp, s.auto_renew,
                COALESCE(s.subscription_period, 'monthly') AS subscription_period,
                s.started_at, s.current_period_end, s.cancelled_at,
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
                  r.avatar_blossom_url, s.price_pence, s.status, s.is_comp,
                  s.auto_renew, s.subscription_period,
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
          isComp: s.is_comp,
          autoRenew: s.auto_renew,
          subscriptionPeriod: s.subscription_period,
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
  // POST /subscriptions/:readerId/comp — grant a comp (free) subscription
  //
  // Writer grants a complimentary subscription to a reader. No charge.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { readerId: string } }>(
    '/subscriptions/:readerId/comp',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!
      const { readerId } = req.params

      if (readerId === writerId) {
        return reply.status(400).send({ error: 'Cannot comp yourself' })
      }

      // Verify reader exists
      const readerResult = await pool.query<{ id: string; nostr_pubkey: string }>(
        `SELECT id, nostr_pubkey FROM accounts WHERE id = $1 AND status = 'active'`,
        [readerId]
      )
      if (readerResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Reader not found' })
      }

      // Check for existing subscription
      const existing = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM subscriptions WHERE reader_id = $1 AND writer_id = $2`,
        [readerId, writerId]
      )

      const now = new Date()
      const periodEnd = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) // 1 year comp

      if (existing.rows.length > 0) {
        const sub = existing.rows[0]
        if (sub.status === 'active') {
          return reply.status(409).send({ error: 'Reader already has an active subscription' })
        }
        // Reactivate as comp
        await pool.query(
          `UPDATE subscriptions
           SET status = 'active', auto_renew = FALSE, is_comp = TRUE, price_pence = 0,
               cancelled_at = NULL, current_period_start = $1, current_period_end = $2,
               updated_at = now()
           WHERE id = $3`,
          [now, periodEnd, sub.id]
        )
        logger.info({ writerId, readerId, subscriptionId: sub.id }, 'Comp subscription granted (reactivated)')
        return reply.status(200).send({ subscriptionId: sub.id, status: 'active', isComp: true })
      }

      // Create new comp subscription
      const result = await pool.query<{ id: string }>(
        `INSERT INTO subscriptions (reader_id, writer_id, price_pence, status, is_comp, auto_renew,
           current_period_start, current_period_end)
         VALUES ($1, $2, 0, 'active', TRUE, FALSE, $3, $4)
         RETURNING id`,
        [readerId, writerId, now, periodEnd]
      )

      const subscriptionId = result.rows[0].id
      logger.info({ writerId, readerId, subscriptionId }, 'Comp subscription granted')

      // Notification
      pool.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         VALUES ($1, $2, 'new_subscriber')
         ON CONFLICT DO NOTHING`,
        [writerId, readerId]
      ).catch(err => logger.warn({ err }, 'Failed to insert new_subscriber notification'))

      return reply.status(201).send({ subscriptionId, status: 'active', isComp: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /subscriptions/:readerId/comp — revoke a comp subscription (writer)
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { readerId: string } }>(
    '/subscriptions/:readerId/comp',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!
      const { readerId } = req.params

      const result = await pool.query(
        `UPDATE subscriptions
         SET status = 'expired', updated_at = now()
         WHERE reader_id = $1 AND writer_id = $2 AND is_comp = TRUE AND status = 'active'
         RETURNING id`,
        [readerId, writerId]
      )

      if ((result.rowCount ?? 0) === 0) {
        return reply.status(404).send({ error: 'No active comp subscription found' })
      }

      logger.info({ writerId, readerId }, 'Comp subscription revoked')
      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /subscription-events — paginated subscription event history
  //
  // Returns subscription_charge and subscription_earning events for the
  // authenticated user (as reader or writer), most recent first.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/subscription-events',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 100)
      const offset = parseInt(req.query.offset ?? '0', 10) || 0

      const { rows } = await pool.query<{
        id: string
        subscription_id: string
        event_type: string
        reader_id: string
        writer_id: string
        amount_pence: number
        period_start: Date | null
        period_end: Date | null
        description: string | null
        created_at: Date
        counterparty_name: string | null
        counterparty_username: string
      }>(
        `SELECT se.id, se.subscription_id, se.event_type,
                se.reader_id, se.writer_id, se.amount_pence,
                se.period_start, se.period_end, se.description, se.created_at,
                CASE
                  WHEN se.reader_id = $1 THEN w.display_name
                  ELSE r.display_name
                END AS counterparty_name,
                CASE
                  WHEN se.reader_id = $1 THEN w.username
                  ELSE r.username
                END AS counterparty_username
         FROM subscription_events se
         JOIN accounts r ON r.id = se.reader_id
         JOIN accounts w ON w.id = se.writer_id
         WHERE (se.reader_id = $1 OR se.writer_id = $1)
           AND se.event_type IN ('subscription_charge', 'subscription_earning')
           AND se.description != 'Expiry warning sent'
         ORDER BY se.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      )

      return reply.status(200).send({
        events: rows.map(e => ({
          id: e.id,
          subscriptionId: e.subscription_id,
          eventType: e.event_type,
          amountPence: e.amount_pence,
          periodStart: e.period_start?.toISOString() ?? null,
          periodEnd: e.period_end?.toISOString() ?? null,
          description: e.description,
          counterpartyName: e.counterparty_name ?? e.counterparty_username,
          counterpartyUsername: e.counterparty_username,
          createdAt: e.created_at.toISOString(),
        })),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /settings/subscription-price — set writer's subscription price
  // ---------------------------------------------------------------------------

  const PriceSchema = z.object({
    pricePence: z.number().int().min(100).max(10000), // £1 to £100
    annualDiscountPct: z.number().int().min(0).max(30).optional(),
    defaultArticlePricePence: z.number().int().min(0).max(10000).nullable().optional(), // NULL = auto-suggest
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
      const { pricePence, annualDiscountPct, defaultArticlePricePence } = parsed.data

      const sets = ['subscription_price_pence = $1', 'updated_at = now()']
      const params: any[] = [pricePence, accountId]
      let paramIdx = 3

      if (annualDiscountPct !== undefined) {
        sets.push(`annual_discount_pct = $${paramIdx}`)
        params.push(annualDiscountPct)
        paramIdx++
      }
      if (defaultArticlePricePence !== undefined) {
        sets.push(`default_article_price_pence = $${paramIdx}`)
        params.push(defaultArticlePricePence)
        paramIdx++
      }

      await pool.query(
        `UPDATE accounts SET ${sets.join(', ')} WHERE id = $2`,
        params
      )

      logger.info({ accountId, pricePence, annualDiscountPct, defaultArticlePricePence }, 'Pricing updated')

      return reply.status(200).send({ ok: true, pricePence, annualDiscountPct, defaultArticlePricePence })
    }
  )

  // ===========================================================================
  // Publication subscriptions
  // ===========================================================================

  // POST /subscriptions/publication/:id — Subscribe to a publication
  app.post<{ Params: { id: string }; Body: { period?: string } }>(
    '/subscriptions/publication/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { id: publicationId } = req.params
      const body = req.body as { period?: string }
      const period = body?.period === 'annual' ? 'annual' : 'monthly'

      // Fetch publication pricing
      const { rows: pubs } = await pool.query<{
        subscription_price_pence: number; annual_discount_pct: number; name: string; nostr_pubkey: string
      }>(
        `SELECT subscription_price_pence, annual_discount_pct, name, nostr_pubkey
         FROM publications WHERE id = $1 AND status = 'active'`,
        [publicationId]
      )
      if (pubs.length === 0) {
        return reply.status(404).send({ error: 'Publication not found' })
      }

      const pub = pubs[0]
      const pricePence = period === 'annual'
        ? Math.round(pub.subscription_price_pence * 12 * (1 - pub.annual_discount_pct / 100))
        : pub.subscription_price_pence

      // Check existing
      const existing = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM subscriptions
         WHERE reader_id = $1 AND publication_id = $2`,
        [readerId, publicationId]
      )

      if (existing.rows.length > 0) {
        const sub = existing.rows[0]
        if (sub.status === 'active') {
          return reply.status(409).send({ error: 'Already subscribed' })
        }
        // Reactivate
        const now = new Date()
        const periodDays = period === 'annual' ? 365 : 30
        const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000)
        await pool.query(
          `UPDATE subscriptions
           SET status = 'active', auto_renew = TRUE, cancelled_at = NULL,
               current_period_start = $1, current_period_end = $2,
               price_pence = $3, subscription_period = $5, updated_at = now()
           WHERE id = $4`,
          [now, periodEnd, pricePence, sub.id, period]
        )
        return reply.status(200).send({ subscriptionId: sub.id, status: 'active', pricePence })
      }

      // Create new
      const now = new Date()
      const periodDays = period === 'annual' ? 365 : 30
      const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000)

      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO subscriptions (reader_id, publication_id, price_pence, status,
           current_period_start, current_period_end, subscription_period)
         VALUES ($1, $2, $3, 'active', $4, $5, $6)
         RETURNING id`,
        [readerId, publicationId, pricePence, now, periodEnd, period]
      )

      // Notify members with can_manage_finances
      pool.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         SELECT pm.account_id, $1, 'pub_new_subscriber'
         FROM publication_members pm
         WHERE pm.publication_id = $2 AND pm.can_manage_finances = TRUE
           AND pm.removed_at IS NULL
         ON CONFLICT DO NOTHING`,
        [readerId, publicationId]
      ).catch(err => logger.warn({ err }, 'Failed to notify pub_new_subscriber'))

      logger.info({ readerId, publicationId, subscriptionId: rows[0].id }, 'Publication subscription created')
      return reply.status(201).send({
        subscriptionId: rows[0].id, status: 'active', pricePence,
        publicationName: pub.name,
        currentPeriodEnd: periodEnd.toISOString(),
      })
    }
  )

  // DELETE /subscriptions/publication/:id — Cancel publication subscription
  app.delete<{ Params: { id: string } }>(
    '/subscriptions/publication/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { id: publicationId } = req.params

      const result = await pool.query(
        `UPDATE subscriptions
         SET status = 'cancelled', auto_renew = FALSE, cancelled_at = now(), updated_at = now()
         WHERE reader_id = $1 AND publication_id = $2 AND status = 'active'
         RETURNING id`,
        [readerId, publicationId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'No active subscription found' })
      }

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /subscriptions/:id/notifications — toggle email-on-publish
  // ---------------------------------------------------------------------------

  const NotifySchema = z.object({
    notifyOnPublish: z.boolean(),
  })

  app.patch<{ Params: { id: string } }>(
    '/subscriptions/:id/notifications',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const { id: subscriptionId } = req.params
      const parsed = NotifySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const result = await pool.query(
        `UPDATE subscriptions
         SET notify_on_publish = $1, updated_at = now()
         WHERE id = $2 AND reader_id = $3 AND status = 'active'
         RETURNING id`,
        [parsed.data.notifyOnPublish, subscriptionId, readerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Subscription not found' })
      }

      return reply.send({ ok: true, notifyOnPublish: parsed.data.notifyOnPublish })
    }
  )
}

// =============================================================================
// Helper — log subscription charge and earning events
// =============================================================================

// =============================================================================
// Subscription renewal and expiry — runs hourly from gateway index
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
        // Revert to writer's current standard price for this period type
        renewalPrice = sub.subscription_period === 'annual'
          ? Math.round(sub.writer_standard_price * 12 * 0.85) // use standard annual calc
          : sub.writer_standard_price
      }

      await withTransaction(async (client) => {
        // Deduct from reader's free allowance (same mechanism as initial subscribe)
        await client.query(
          `UPDATE accounts SET free_allowance_remaining_pence = free_allowance_remaining_pence - $1, updated_at = now() WHERE id = $2`,
          [renewalPrice, sub.reader_id]
        )

        // Roll the period forward and handle offer period tracking
        if (offerExpiring) {
          // Offer period done — clear offer, revert price
          await client.query(
            `UPDATE subscriptions
             SET current_period_start = $1, current_period_end = $2,
                 price_pence = $3, offer_id = NULL, offer_periods_remaining = NULL, updated_at = now()
             WHERE id = $4`,
            [newPeriodStart, newPeriodEnd, renewalPrice, sub.id]
          )
        } else if (sub.offer_periods_remaining !== null) {
          // Decrement remaining offer periods
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

        // Log charge and earning events
        await logSubscriptionCharge(client, sub.id, sub.reader_id, sub.writer_id, renewalPrice, newPeriodStart, newPeriodEnd)
      })

      // Publish renewed Nostr attestation — non-blocking
      publishSubscriptionEvent({
        subscriptionId: sub.id,
        readerPubkey: sub.reader_pubkey,
        writerPubkey: sub.writer_pubkey,
        status: 'active',
        pricePence: renewalPrice,
        periodStart: sub.current_period_end,
        periodEnd: new Date(sub.current_period_end.getTime() + (sub.subscription_period === 'annual' ? 365 : 30) * 24 * 60 * 60 * 1000),
      }).then(nostrEventId =>
        pool.query(`UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`, [nostrEventId, sub.id])
      ).catch(err =>
        logger.error({ err, subscriptionId: sub.id }, 'Renewal Nostr event failed')
      )

      // Send renewal email — non-blocking
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
           AND se.event_type = 'subscription_charge'
           AND se.description = 'Expiry warning sent'
           AND se.created_at > now() - INTERVAL '4 days'
       )`
  )

  for (const sub of expiringSoon.rows) {
    sendSubscriptionExpiryWarningEmail(sub.reader_id, sub.writer_id, sub.current_period_end).catch(err =>
      logger.warn({ err, subscriptionId: sub.id }, 'Expiry warning email failed')
    )
    // Mark that we sent the warning (prevents re-sending)
    pool.query(
      `INSERT INTO subscription_events (subscription_id, event_type, reader_id, writer_id, amount_pence, description)
       VALUES ($1, 'subscription_charge', $2, $3, 0, 'Expiry warning sent')`,
      [sub.id, sub.reader_id, sub.writer_id]
    ).catch(err => logger.warn({ err }, 'Failed to insert expiry warning subscription_event'))
  }

  return processed
}

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
