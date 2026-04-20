import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { z } from 'zod'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Subscription Offer Routes
//
// POST   /subscription-offers              — create an offer (code or grant)
// GET    /subscription-offers              — list writer's offers
// DELETE /subscription-offers/:offerId     — revoke an offer
// GET    /subscription-offers/redeem/:code — public lookup for redeem page
// =============================================================================

export async function subscriptionOfferRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /subscription-offers — create an offer
  // ---------------------------------------------------------------------------

  const CreateOfferSchema = z.object({
    label: z.string().min(1).max(200),
    mode: z.enum(['code', 'grant']),
    discountPct: z.number().int().min(0).max(100),
    durationMonths: z.number().int().min(1).max(120).nullable().optional(),
    maxRedemptions: z.number().int().min(1).max(100000).nullable().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    recipientUsername: z.string().optional(),
  })

  app.post(
    '/subscription-offers',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!

      const parsed = CreateOfferSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { label, mode, discountPct, durationMonths, maxRedemptions, expiresAt, recipientUsername } = parsed.data

      // Resolve recipient for grant mode
      let recipientId: string | null = null
      if (mode === 'grant') {
        if (!recipientUsername) {
          return reply.status(400).send({ error: 'recipientUsername is required for grant offers' })
        }
        const recipient = await pool.query<{ id: string }>(
          `SELECT id FROM accounts WHERE username = $1 AND status = 'active'`,
          [recipientUsername]
        )
        if (recipient.rowCount === 0) {
          return reply.status(404).send({ error: 'Recipient not found' })
        }
        recipientId = recipient.rows[0].id
      }

      const code = mode === 'code' ? crypto.randomBytes(8).toString('base64url') : null

      const { rows } = await pool.query<{ id: string; code: string | null }>(
        `INSERT INTO subscription_offers
           (writer_id, label, mode, discount_pct, duration_months, code, recipient_id, max_redemptions, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, code`,
        [
          writerId, label, mode, discountPct,
          durationMonths ?? null,
          code,
          recipientId,
          maxRedemptions ?? null,
          expiresAt ?? null,
        ]
      )

      const offer = rows[0]
      const url = code ? `/subscribe/${code}` : null

      logger.info({ writerId, offerId: offer.id, mode, discountPct }, 'Subscription offer created')
      return reply.status(201).send({
        id: offer.id,
        code: offer.code,
        url,
        label,
        mode,
        discountPct,
        durationMonths: durationMonths ?? null,
        maxRedemptions: maxRedemptions ?? null,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /subscription-offers — list writer's offers
  // ---------------------------------------------------------------------------

  app.get(
    '/subscription-offers',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!

      const { rows } = await pool.query<{
        id: string
        label: string
        mode: string
        discount_pct: number
        duration_months: number | null
        code: string | null
        recipient_id: string | null
        recipient_username: string | null
        max_redemptions: number | null
        redemption_count: number
        expires_at: Date | null
        revoked_at: Date | null
        created_at: Date
      }>(
        `SELECT so.*,
                a.username AS recipient_username
         FROM subscription_offers so
         LEFT JOIN accounts a ON a.id = so.recipient_id
         WHERE so.writer_id = $1
         ORDER BY so.created_at DESC`,
        [writerId]
      )

      return reply.status(200).send({
        offers: rows.map(r => ({
          id: r.id,
          label: r.label,
          mode: r.mode,
          discountPct: r.discount_pct,
          durationMonths: r.duration_months,
          code: r.code,
          recipientId: r.recipient_id,
          recipientUsername: r.recipient_username,
          maxRedemptions: r.max_redemptions,
          redemptionCount: r.redemption_count,
          expiresAt: r.expires_at?.toISOString() ?? null,
          revoked: r.revoked_at !== null,
          createdAt: r.created_at.toISOString(),
        })),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /subscription-offers/:offerId — revoke an offer
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { offerId: string } }>(
    '/subscription-offers/:offerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub!
      const { offerId } = req.params

      const result = await pool.query(
        `UPDATE subscription_offers SET revoked_at = now()
         WHERE id = $1 AND writer_id = $2 AND revoked_at IS NULL`,
        [offerId, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Offer not found' })
      }

      logger.info({ writerId, offerId }, 'Subscription offer revoked')
      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /subscription-offers/redeem/:code — public lookup for the redeem page
  // ---------------------------------------------------------------------------

  app.get<{ Params: { code: string } }>(
    '/subscription-offers/redeem/:code',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { code } = req.params

      const { rows } = await pool.query<{
        id: string
        label: string
        mode: string
        discount_pct: number
        duration_months: number | null
        max_redemptions: number | null
        redemption_count: number
        expires_at: Date | null
        writer_id: string
        writer_username: string
        writer_display_name: string | null
        subscription_price_pence: number
      }>(
        `SELECT so.id, so.label, so.mode, so.discount_pct, so.duration_months,
                so.max_redemptions, so.redemption_count, so.expires_at,
                a.id AS writer_id, a.username AS writer_username,
                a.display_name AS writer_display_name,
                a.subscription_price_pence
         FROM subscription_offers so
         JOIN accounts a ON a.id = so.writer_id
         WHERE so.code = $1
           AND so.revoked_at IS NULL
           AND so.mode = 'code'`,
        [code]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Offer not found or no longer available' })
      }

      const offer = rows[0]

      // Check expiration and redemption limits
      if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
        return reply.status(410).send({ error: 'This offer has expired' })
      }
      if (offer.max_redemptions !== null && offer.redemption_count >= offer.max_redemptions) {
        return reply.status(410).send({ error: 'This offer has been fully redeemed' })
      }

      const standardPrice = offer.subscription_price_pence
      const discountedPrice = Math.round(standardPrice * (1 - offer.discount_pct / 100))

      return reply.status(200).send({
        id: offer.id,
        label: offer.label,
        discountPct: offer.discount_pct,
        durationMonths: offer.duration_months,
        writerId: offer.writer_id,
        writerUsername: offer.writer_username,
        writerDisplayName: offer.writer_display_name,
        standardPricePence: standardPrice,
        discountedPricePence: discountedPrice,
      })
    }
  )
}
