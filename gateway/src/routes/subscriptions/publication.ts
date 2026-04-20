import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Publication subscriptions
//
// POST   /subscriptions/publication/:id — Subscribe to a publication
// DELETE /subscriptions/publication/:id — Cancel publication subscription
// =============================================================================

export async function subscriptionPublicationRoutes(app: FastifyInstance) {
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
}
