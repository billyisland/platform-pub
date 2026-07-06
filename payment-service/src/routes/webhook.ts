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

    // Try each configured signing secret. The main account endpoint uses
    // STRIPE_WEBHOOK_SECRET; if Connect events (account.updated / transfer.* /
    // deauthorized) are delivered via a SEPARATE Stripe endpoint, that endpoint
    // has its own secret — set STRIPE_CONNECT_WEBHOOK_SECRET and we verify
    // against both. (If Connect events ride the same endpoint — "listen to
    // events on connected accounts" — one secret suffices.) STRIPE audit S4.
    const secrets = [
      process.env.STRIPE_WEBHOOK_SECRET,
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    ].filter((s): s is string => Boolean(s))

    let event: Stripe.Event | null = null
    let lastErr: unknown
    for (const secret of secrets) {
      try {
        event = stripe.webhooks.constructEvent(req.body as Buffer, sig, secret)
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!event) {
      logger.warn({ err: lastErr }, 'Stripe webhook signature verification failed')
      return reply.status(400).send({ error: 'Invalid signature' })
    }

    // livemode guard: derive the expected mode from the secret key
    // (sk_live_/rk_live_ → live). A test-mode event hitting the live endpoint
    // (or vice versa) is misrouted — ack it (200, so Stripe stops retrying) but
    // do NOT process it against real-money state. STRIPE audit S4.
    const expectLive =
      (process.env.STRIPE_SECRET_KEY ?? '').split('_')[1] === 'live'
    if (event.livemode !== expectLive) {
      logger.warn(
        {
          eventId: event.id,
          eventType: event.type,
          eventLivemode: event.livemode,
          expectLive,
        },
        'Stripe webhook livemode mismatch — ignoring (misrouted test/live event)'
      )
      return reply.status(200).send({ received: true, ignored: 'livemode_mismatch' })
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

  // Cast to string: the Stripe SDK's Event.type union doesn't include every event
  // we handle at runtime (the transfer.* events below), so we widen it.
  //
  // Audit F4 (2026-07-06): transfer.paid / transfer.failed do NOT fire for
  // platform→connected-account transfers — Stripe emits only transfer.created /
  // updated / reversed for those (the legacy paid/failed events are for a
  // connected account's transfers to ITS OWN bank, not transfers TO the connected
  // account). Payout completion is therefore keyed off the transfers.create
  // response (payout.ts), not these webhooks. The paid/failed cases below are
  // retained as GUARDED NO-OPS (completion at create-time + status guards make a
  // stray delivery harmless) pending a live-Stripe confirmation before deletion.
  // transfer.reversed IS delivered for these transfers and is handled below.
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
      // Route by the metadata stamped at transfer creation. Writer, tribute, and
      // publication-split transfers all emit transfer.paid/failed but land in
      // different tables — confirmPayout only knows writer_payouts, so an
      // un-routed tribute/pub transfer would hit its no-match no-op and never
      // confirm (or, on failure, never roll back).
      const m = transfer.metadata ?? {}
      if (m.tribute_payout_id) {
        await payoutService.confirmTributePayout(transfer.id)
      } else if (m.publication_payout_id) {
        await payoutService.confirmPublicationSplit(transfer.id)
      } else {
        await payoutService.confirmPayout(transfer.id)
      }
      break
    }

    case 'transfer.failed': {
      const transfer = event.data.object as Stripe.Transfer
      const m = transfer.metadata ?? {}
      if (m.tribute_payout_id) {
        await payoutService.handleFailedTributePayout(transfer.id, 'Transfer failed')
      } else if (m.publication_payout_id) {
        await payoutService.handleFailedPublicationSplit(transfer.id, 'Transfer failed')
      } else {
        await payoutService.handleFailedPayout(transfer.id, 'Transfer failed')
      }
      break
    }

    // -------------------------------------------------------------------------
    // Audit F4: transfer.reversed — Stripe clawed a COMPLETED payout's funds
    // back to the platform (platform-initiated reversal). This event IS emitted
    // for platform→connected transfers. Reverse the payout: mark it 'reversed'
    // and post the reversing ledger entry (mirrors the chargeback posture — the
    // recipient's earned total goes negative, reads/accruals stay in place, no
    // synchronous re-pay). Routed by the same metadata as paid/failed.
    // -------------------------------------------------------------------------
    case 'transfer.reversed': {
      const transfer = event.data.object as Stripe.Transfer
      const m = transfer.metadata ?? {}
      if (m.tribute_payout_id) {
        await payoutService.reverseTributePayout(transfer.id)
      } else if (m.publication_payout_id) {
        await payoutService.reversePublicationSplit(transfer.id)
      } else {
        await payoutService.reverseWriterPayout(transfer.id)
      }
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
        // The per-read model can't proportionally unwind, so a partial refund
        // leaves the reader charged + writers paid. Emit the alertable
        // manual_review_required marker (the event is also durably persisted in
        // stripe_webhook_events) so ops actions it rather than losing it in
        // logs. STRIPE audit S4.
        logger.warn(
          {
            event: 'manual_review_required',
            kind: 'partial_refund',
            chargeId: charge.id,
            amountRefunded: charge.amount_refunded,
            amount: charge.amount,
          },
          'Partial refund — not auto-reversing (per-read unwind supports full reversal only); MANUAL REVIEW required',
        )
        break
      }
      await settlementService.reverseSettlement(charge.id, 'refund')
      break
    }

    case 'charge.dispute.created': {
      // A dispute was OPENED. We do not reverse here (it may yet be won; the
      // reversal fires on charge.dispute.closed with status=lost). Surface it
      // with the alertable marker so ops tracks the open dispute and its
      // response deadline rather than discovering it only at close. STRIPE
      // audit S4.
      const dispute = event.data.object as Stripe.Dispute
      const chargeId =
        typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id ?? ''
      logger.warn(
        {
          event: 'manual_review_required',
          kind: 'dispute_opened',
          disputeId: dispute.id,
          chargeId,
          amount: dispute.amount,
          reason: dispute.reason,
          dueBy: dispute.evidence_details?.due_by ?? null,
        },
        'Dispute OPENED on a charge — MANUAL REVIEW required (no auto-reversal until dispute.closed=lost)',
      )
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
      //
      // Bidirectional (STRIPE audit S3): payability is NOT one-way. If Stripe
      // later disables a writer's transfers capability / payouts (compliance
      // review, fraud, negative balance), this same event fires with the
      // capability inactive — flip them back to incomplete so the payout cycle
      // stops selecting them (each transfer would otherwise be rejected, cycle
      // after cycle). Previously only the TRUE direction was handled.
      if (isConnectPayable(account)) {
        await handleConnectKycComplete(account.id)
      } else {
        await handleConnectPayableLost(account.id)
      }
      break
    }

    case 'account.application.deauthorized': {
      // The writer disconnected their Connect account from the platform. Stripe
      // can no longer transfer to it, so clear payability — leaving a stale
      // stripe_connect_kyc_complete = TRUE would keep the payout cycle targeting
      // a severed account (STRIPE audit S3). On this Connect event the connected
      // account id is the top-level event.account, not event.data.object (which
      // is the Application).
      await handleConnectDeauthorized(event.account ?? null)
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

// ---------------------------------------------------------------------------
// handleConnectPayableLost — a previously-payable writer is no longer payable
// (transfers capability disabled / payouts off). Flip them back to incomplete
// so the payout cycle skips them. Guarded on `= TRUE` so it's a no-op for an
// account that was never marked complete (the common case for an in-progress
// onboarding's account.updated stream). STRIPE audit S3.
// ---------------------------------------------------------------------------

async function handleConnectPayableLost(stripeConnectId: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE accounts
     SET stripe_connect_kyc_complete = FALSE, updated_at = now()
     WHERE stripe_connect_id = $1 AND stripe_connect_kyc_complete = TRUE
     RETURNING id`,
    [stripeConnectId]
  )

  if (rows.length === 0) return // not previously complete — nothing to demote

  logger.warn(
    { writerId: rows[0].id, stripeConnectId },
    'Writer Connect payability lost (transfers/payouts disabled) — removed from payout cycle'
  )
}

// ---------------------------------------------------------------------------
// handleConnectDeauthorized — the writer revoked the platform's access to their
// Connect account. Clear payability so the payout cycle stops targeting it. We
// keep stripe_connect_id (the payout audit trail + a re-authorize re-flips it
// via account.updated); kyc_complete = FALSE alone drops them from the cycle,
// which requires kyc_complete = TRUE. STRIPE audit S3.
// ---------------------------------------------------------------------------

async function handleConnectDeauthorized(stripeConnectId: string | null): Promise<void> {
  if (!stripeConnectId) {
    logger.warn({}, 'account.application.deauthorized with no connected account id — ignoring')
    return
  }

  const { rows } = await pool.query<{ id: string }>(
    `UPDATE accounts
     SET stripe_connect_kyc_complete = FALSE, updated_at = now()
     WHERE stripe_connect_id = $1 AND stripe_connect_kyc_complete = TRUE
     RETURNING id`,
    [stripeConnectId]
  )

  if (rows.length === 0) {
    logger.info({ stripeConnectId }, 'Deauthorize event for an account that was not payable — no change')
    return
  }

  logger.warn(
    { writerId: rows[0].id, stripeConnectId },
    'Writer deauthorized Connect — cleared payable state, dropped from payout cycle'
  )
}
