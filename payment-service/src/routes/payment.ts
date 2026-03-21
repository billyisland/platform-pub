import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { accrualService } from '../services/accrual.js'
import { settlementService } from '../services/settlement.js'
import { payoutService } from '../services/payout.js'
import logger from '../lib/logger.js'

// =============================================================================
// Payment API Routes
//
// These are internal service routes — not exposed to the public internet.
// Called by the web client and key service via internal service mesh.
// Auth is handled at the gateway; these routes trust the caller.
// =============================================================================

// FIX #11: Removed onFreeAllowance from the schema. The accrual service
// determines free-allowance status from the database (whether the reader has
// a stripe_customer_id), not from the caller's assertion. Including it in the
// API contract was misleading — the field was accepted but ignored.
const GatePassSchema = z.object({
  readerId: z.string().uuid(),
  articleId: z.string().uuid(),
  writerId: z.string().uuid(),
  amountPence: z.number().int().positive(),
  readerPubkey: z.string().min(1),
  readerPubkeyHash: z.string(),
  tabId: z.string().uuid(),
})

const CardConnectedSchema = z.object({
  readerId: z.string().uuid(),
  stripeCustomerId: z.string(),
})

export async function paymentRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /gate-pass
  // Called by the key service after confirming a reader should receive a key.
  // Records the read and triggers settlement check.
  // ---------------------------------------------------------------------------

  app.post('/gate-pass', async (req, reply) => {
    const parsed = GatePassSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    try {
      const { readEvent, allowanceJustExhausted } = await accrualService.recordGatePass(parsed.data)

      // After recording the read, check if settlement threshold is crossed
      // Non-blocking — settlement failure should not block content delivery
      if (readEvent.state === 'accrued') {
        settlementService.checkAndSettle(parsed.data.readerId, 'threshold').catch((err) => {
          logger.error({ err, readerId: parsed.data.readerId }, 'Post-gate-pass settlement check failed')
        })
      }

      return reply.status(201).send({ readEventId: readEvent.id, state: readEvent.state, allowanceJustExhausted })
    } catch (err: any) {
      logger.error({ err }, 'Gate pass failed')
      return reply.status(500).send({ error: 'Internal error' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /card-connected
  // Called when a reader successfully adds a payment method.
  // Converts provisional reads to accrued and checks settlement threshold.
  // ---------------------------------------------------------------------------

  app.post('/card-connected', async (req, reply) => {
    const parsed = CardConnectedSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { readerId, stripeCustomerId } = parsed.data

    // Record the Stripe customer ID on the account
    const { pool } = await import('../db/client.js')
    await pool.query(
      `UPDATE accounts SET stripe_customer_id = $1, updated_at = now() WHERE id = $2`,
      [stripeCustomerId, readerId]
    )

    // Convert provisional reads
    const converted = await accrualService.convertProvisionalReads(readerId)

    // Check if newly accrued balance triggers settlement
    if (converted > 0) {
      settlementService.checkAndSettle(readerId, 'threshold').catch((err) => {
        logger.error({ err, readerId }, 'Post-card-connect settlement check failed')
      })
    }

    return reply.status(200).send({ convertedReads: converted })
  })

  // ---------------------------------------------------------------------------
  // GET /earnings/:writerId
  // Writer earnings dashboard data — only platform_settled + writer_paid
  // ---------------------------------------------------------------------------

  app.get('/earnings/:writerId', async (req, reply) => {
    const { writerId } = req.params as { writerId: string }

    if (!writerId.match(/^[0-9a-f-]{36}$/)) {
      return reply.status(400).send({ error: 'Invalid writer ID' })
    }

    const earnings = await payoutService.getWriterEarnings(writerId)
    return reply.status(200).send(earnings)
  })

  // ---------------------------------------------------------------------------
  // GET /earnings/:writerId/articles
  // Per-article earnings breakdown — per ADR §I.2:
  // "The dashboard must show settled per-article revenue."
  // ---------------------------------------------------------------------------

  app.get('/earnings/:writerId/articles', async (req, reply) => {
    const { writerId } = req.params as { writerId: string }

    if (!writerId.match(/^[0-9a-f-]{36}$/)) {
      return reply.status(400).send({ error: 'Invalid writer ID' })
    }

    const earnings = await payoutService.getPerArticleEarnings(writerId)
    return reply.status(200).send({ articles: earnings })
  })

  // ---------------------------------------------------------------------------
  // POST /payout-cycle (internal — called by cron worker)
  // ---------------------------------------------------------------------------

  app.post('/payout-cycle', async (req, reply) => {
    // Validate internal caller token
    const token = req.headers['x-internal-token']
    if (token !== process.env.INTERNAL_SERVICE_TOKEN) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const result = await payoutService.runPayoutCycle()
    return reply.status(200).send(result)
  })

  // ---------------------------------------------------------------------------
  // POST /settlement-check/monthly (internal — called by monthly fallback cron)
  //
  // FIX #3: The query now filters for tabs with last_read_at older than
  // 30 days (matching the ADR's "one month after the last payment" language),
  // rather than blindly processing all tabs with any balance.
  // ---------------------------------------------------------------------------

  app.post('/settlement-check/monthly', async (req, reply) => {
    const token = req.headers['x-internal-token']
    if (token !== process.env.INTERNAL_SERVICE_TOKEN) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const { pool } = await import('../db/client.js')
    const { rows } = await pool.query<{ reader_id: string }>(
      `SELECT DISTINCT reader_id FROM reading_tabs
       WHERE balance_pence > 0
         AND last_read_at < now() - INTERVAL '30 days'`
    )

    let settled = 0
    for (const row of rows) {
      try {
        const id = await settlementService.checkAndSettle(row.reader_id, 'monthly_fallback')
        if (id) settled++
      } catch (err) {
        logger.error({ err, readerId: row.reader_id }, 'Monthly fallback settlement failed')
      }
    }

    return reply.status(200).send({ settlementTriggered: settled })
  })
}
