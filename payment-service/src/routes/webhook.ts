import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import Stripe from 'stripe'
import { settlementService } from '../services/settlement.js'
import { payoutService } from '../services/payout.js'
import { accrualService } from '../services/accrual.js'
import logger from '../lib/logger.js'

// =============================================================================
// Stripe Webhook Route
//
// All state advancement is driven by webhooks, not API responses.
// This is intentional — Stripe guarantees at-least-once delivery of webhook
// events, which is the right durability contract for financial state changes.
//
// The webhook secret is verified before any processing. Raw body is required
// for signature verification — do not use JSON body parser on this route.
// =============================================================================

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
})

export async function webhookRoutes(app: FastifyInstance) {
  // Raw body needed for Stripe signature verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1_048_576 },
    (req, body, done) => done(null, body)
  )

  app.post('/webhooks/stripe', async (req: FastifyRequest, reply: FastifyReply) => {
    const sig = req.headers['stripe-signature']

    if (!sig || typeof sig !== 'string') {
      return reply.status(400).send({ error: 'Missing Stripe signature' })
    }

    let event: Stripe.Event

    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch (err) {
      logger.warn({ err }, 'Stripe webhook signature verification failed')
      return reply.status(400).send({ error: 'Invalid signature' })
    }

    try {
      await handleStripeEvent(event)
      return reply.status(200).send({ received: true })
    } catch (err) {
      // Return 500 so Stripe retries — do not ack events we failed to process
      logger.error({ err, eventType: event.type, eventId: event.id }, 'Webhook handler failed')
      return reply.status(500).send({ error: 'Processing failed' })
    }
  })
}

// ---------------------------------------------------------------------------
// handleStripeEvent — routes to the correct service method
// ---------------------------------------------------------------------------

async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  logger.info({ eventType: event.type, eventId: event.id }, 'Stripe webhook received')

  switch (event.type) {
    // -------------------------------------------------------------------------
    // Stage 2: Reader tab settlement confirmed
    // -------------------------------------------------------------------------
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      const chargeId = typeof pi.latest_charge === 'string'
        ? pi.latest_charge
        : pi.latest_charge?.id ?? ''

      await settlementService.confirmSettlement(pi.id, chargeId)
      break
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      const failureMessage = pi.last_payment_error?.message ?? 'Unknown failure'
      await settlementService.handleFailedPayment(pi.id, failureMessage)
      break
    }

    // -------------------------------------------------------------------------
    // Stage 3: Writer payout
    //
    // FIX #14: Changed from transfer.created to transfer.paid.
    // transfer.created fires when the transfer object is created in Stripe,
    // NOT when funds actually arrive in the writer's account. Confirming
    // a payout as 'completed' on creation is premature. transfer.paid fires
    // when the transfer has actually been paid out to the connected account.
    // -------------------------------------------------------------------------
    case 'transfer.paid': {
      const transfer = event.data.object as Stripe.Transfer
      await payoutService.confirmPayout(transfer.id)
      break
    }

    case 'transfer.failed': {
      const transfer = event.data.object as Stripe.Transfer
      await payoutService.handleFailedPayout(transfer.id, 'Transfer failed')
      break
    }

    // -------------------------------------------------------------------------
    // Writer Stripe Connect KYC completed
    // -------------------------------------------------------------------------
    case 'account.updated': {
      const account = event.data.object as Stripe.Account
      if (account.charges_enabled && account.payouts_enabled) {
        await handleConnectKycComplete(account.id)
      }
      break
    }

    default:
      logger.debug({ eventType: event.type }, 'Unhandled Stripe event — ignoring')
  }
}

// ---------------------------------------------------------------------------
// handleConnectKycComplete — mark writer as KYC-verified, trigger payout check
// ---------------------------------------------------------------------------

async function handleConnectKycComplete(stripeConnectId: string): Promise<void> {
  const { pool } = await import('../db/client.js')

  const { rows } = await pool.query<{ id: string }>(
    `UPDATE accounts
     SET stripe_connect_kyc_complete = TRUE, updated_at = now()
     WHERE stripe_connect_id = $1
     RETURNING id`,
    [stripeConnectId]
  )

  if (rows.length === 0) {
    logger.warn({ stripeConnectId }, 'KYC complete event for unknown Connect account')
    return
  }

  logger.info({ writerId: rows[0].id, stripeConnectId }, 'Writer KYC complete — payout cycle will pick up earnings')
}
