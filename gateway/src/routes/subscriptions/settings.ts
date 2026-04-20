import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// PATCH /settings/subscription-price — writer's pricing settings
// =============================================================================

const PriceSchema = z.object({
  pricePence: z.number().int().min(100).max(10000), // £1 to £100
  annualDiscountPct: z.number().int().min(0).max(30).optional(),
  defaultArticlePricePence: z.number().int().min(0).max(10000).nullable().optional(), // NULL = auto-suggest
})

export async function subscriptionSettingsRoutes(app: FastifyInstance) {
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
}
