import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import Stripe from 'stripe'
import { pool } from '@platform-pub/shared/db/client.js'
import { settlementService } from '../services/settlement.js'
import { payoutService } from '../services/payout.js'
import { isConnectPayable } from '../lib/connect-payable.js'
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
      // Claim the event: insert a receipt row (processed_at stays NULL) or
      // read an existing one. If processed_at IS NOT NULL the handler has
      // already completed for this event — skip. If NULL, either this is a
      // fresh event or a prior attempt crashed mid-handler, and we should
      // run the handler (handlers are expected to be idempotent because
      // Stripe delivers at least once). The processed_at timestamp is set
      // only after the handler returns successfully, so a crash between
      // claim and completion leaves the row claimable by the next retry.
      const { rows } = await pool.query<{ processed_at: Date | null }>(
        `INSERT INTO stripe_webhook_events (event_id, event_type)
         VALUES ($1, $2)
         ON CONFLICT (event_id) DO UPDATE SET event_type = stripe_webhook_events.event_type
         RETURNING processed_at`,
        [event.id, event.type]
      )
      if (rows[0].processed_at !== null) {
        logger.info({ eventId: event.id }, 'Duplicate webhook event — skipping')
        return reply.status(200).send({ received: true })
      }

      await handleStripeEvent(event)

      await pool.query(
        `UPDATE stripe_webhook_events SET processed_at = now() WHERE event_id = $1`,
        [event.id]
      )
      return reply.status(200).send({ received: true })
    } catch (err) {
      // Leave processed_at NULL so Stripe's retry can re-attempt. The claim
      // row stays as proof of receipt; only the completion marker is
      // conditional.
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

  // Cast to string: Stripe SDK v14 types don't include all webhook event types
  // (e.g. 'transfer.paid', 'transfer.failed') but they are valid at runtime.
  switch (event.type as string) {
    // -------------------------------------------------------------------------
    // Stage 2: Reader tab settlement confirmed
    // -------------------------------------------------------------------------
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      const chargeId = typeof pi.latest_charge === 'string'
        ? pi.latest_charge
        : pi.latest_charge?.id ?? ''

      if (!chargeId) {
        logger.error({ paymentIntentId: pi.id }, 'payment_intent.succeeded missing latest_charge — skipping settlement confirmation')
        break
      }

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
    // F3: reader chargeback / refund unwind.
    //
    // A reversed reader charge must roll back the settled reads it paid for, and
    // (when tributes are live) void/reverse their tribute accruals. The charge id
    // is the key into tab_settlements.stripe_charge_id.
    //
    // We reverse only when funds are DEFINITIVELY gone:
    //   • charge.dispute.closed with status='lost' — a dispute we lost. We do NOT
    //     act on dispute.created (it may yet be won; no re-apply path to maintain).
    //   • charge.refunded — but FULL refunds only. A partial refund needs
    //     proportional unwinding the per-read model doesn't support; we log and
    //     skip rather than reverse the whole settlement incorrectly.
    // -------------------------------------------------------------------------
    case 'charge.dispute.closed': {
      const dispute = event.data.object as Stripe.Dispute
      if (dispute.status !== 'lost') {
        logger.info({ disputeId: dispute.id, status: dispute.status }, 'Dispute closed but not lost — no reversal')
        break
      }
      const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id ?? ''
      if (!chargeId) {
        logger.error({ disputeId: dispute.id }, 'dispute.closed missing charge — cannot reverse')
        break
      }
      await settlementService.reverseSettlement(chargeId, 'chargeback_lost')
      break
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge
      if (charge.amount_refunded < charge.amount) {
        logger.warn(
          { chargeId: charge.id, amountRefunded: charge.amount_refunded, amount: charge.amount },
          'Partial refund — not reversing (per-read unwind supports full reversal only)',
        )
        break
      }
      await settlementService.reverseSettlement(charge.id, 'refund')
      break
    }

    // -------------------------------------------------------------------------
    // Writer Stripe Connect KYC completed
    // -------------------------------------------------------------------------
    case 'account.updated': {
      const account = event.data.object as Stripe.Account
      // Gate via the shared isConnectPayable() — see its comment for why we key
      // on transfers/payouts and not charges_enabled. The reconciliation sweep
      // (payout.ts::reconcileConnectKyc) applies the SAME helper as a backstop
      // for missed account.updated events.
      if (isConnectPayable(account)) {
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
