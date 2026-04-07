import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { signup, SignupSchema, getAccount, updateProfile, connectStripeAccount, connectPaymentMethod } from '../../shared/src/auth/accounts.js'
import { createSession, destroySession } from '../../shared/src/auth/session.js'
import { requestMagicLink, verifyMagicLink } from '../../shared/src/auth/magic-links.js'
import { pool } from '../../shared/src/db/client.js'
import { sendMagicLinkEmail } from '../../shared/src/lib/email.js'
import { requireAuth } from '../middleware/auth.js'
import { generateKeypair } from '../lib/key-custody-client.js'
import Stripe from 'stripe'
import logger from '../../shared/src/lib/logger.js'
import { requireEnv } from '../../shared/src/lib/env.js'

// =============================================================================
// Auth Routes — mounted on the gateway
//
// POST /auth/signup          — create account (email, username, displayName)
// POST /auth/login           — magic link login (sends email)
// POST /auth/verify          — verify magic link token → set session
// POST /auth/logout          — clear session
// GET  /auth/me              — current account info (session hydration)
// POST /auth/upgrade-writer  — start Stripe Connect onboarding
// POST /auth/connect-card    — save reader payment method
// =============================================================================

const stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
  apiVersion: '2023-10-16',
})

export async function authRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /auth/signup
  // ---------------------------------------------------------------------------

  app.post('/auth/signup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = SignupSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    try {
      // Generate keypair via key-custody service — gateway never sees ACCOUNT_KEY_HEX
      const keypair = await generateKeypair()
      const result = await signup(parsed.data, reply, keypair)
      return reply.status(201).send(result)
    } catch (err: any) {
      // Unique constraint violations (duplicate username, email, or pubkey)
      if (err.code === '23505') {
        const field = err.constraint?.includes('username') ? 'username'
                    : err.constraint?.includes('email') ? 'email'
                    : 'account'
        return reply.status(409).send({ error: `${field}_taken` })
      }
      logger.error({ err }, 'Signup failed')
      return reply.status(500).send({ error: 'Signup failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /auth/login — magic link
  //
  // Passwordless email login: user enters email → one-time link sent →
  // link contains a signed token → POST /auth/verify validates it → session set.
  // ---------------------------------------------------------------------------

  const LoginSchema = z.object({
    email: z.string().email(),
  })

  app.post('/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const result = await requestMagicLink(parsed.data.email)

    if (result) {
      // Send the magic link email
      // In dev (EMAIL_PROVIDER=console), this logs to stdout
      // In production, set EMAIL_PROVIDER=postmark or resend
      try {
        await sendMagicLinkEmail(parsed.data.email, result.token, result.expiresAt)
      } catch (err) {
        logger.error({ err, email: parsed.data.email.slice(0, 3) + '***' }, 'Magic link email failed')
        // Don't fail the request — the token is still valid, and we don't
        // want to reveal whether an account exists via email delivery errors
      }
    }

    // Always return the same response — don't reveal whether the account exists
    return reply.status(200).send({
      message: 'If an account exists with that email, a login link has been sent.',
    })
  })

  // ---------------------------------------------------------------------------
  // POST /auth/verify — verify magic link token → create session
  // ---------------------------------------------------------------------------

  const VerifySchema = z.object({
    token: z.string().min(1),
  })

  app.post('/auth/verify', async (req, reply) => {
    const parsed = VerifySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = await verifyMagicLink(parsed.data.token)
    if (!accountId) {
      return reply.status(401).send({ error: 'Invalid or expired login link' })
    }

    const account = await getAccount(accountId)
    if (!account) {
      return reply.status(404).send({ error: 'Account not found' })
    }

    // Create session
    await createSession(reply, {
      id: account.id,
      nostrPubkey: account.nostrPubkey,
      isWriter: account.isWriter,
    })

    return reply.status(200).send({
      id: account.id,
      username: account.username,
      displayName: account.displayName,
    })
  })

  // ---------------------------------------------------------------------------
  // POST /auth/dev-login — instant login for local development (no magic link)
  // Only available when NODE_ENV=development
  // ---------------------------------------------------------------------------

  if (process.env.NODE_ENV === 'development') {
    app.post('/auth/dev-login', async (req, reply) => {
      const parsed = LoginSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM accounts WHERE email = $1 AND status = $2',
        [parsed.data.email.toLowerCase().trim(), 'active']
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'No account found with that email' })
      }

      const account = await getAccount(rows[0].id)
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' })
      }

      await createSession(reply, {
        id: account.id,
        nostrPubkey: account.nostrPubkey,
        isWriter: account.isWriter,
      })

      logger.info({ email: parsed.data.email, accountId: account.id }, 'Dev login — session created')

      return reply.status(200).send({
        id: account.id,
        username: account.username,
        displayName: account.displayName,
      })
    })
  }

  // ---------------------------------------------------------------------------
  // POST /auth/logout
  // ---------------------------------------------------------------------------

  app.post('/auth/logout', async (req, reply) => {
    destroySession(reply)
    return reply.status(200).send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // GET /auth/me — session hydration
  // Returns the current user's account info, or 401 if not logged in.
  // The web client calls this on page load to hydrate auth state.
  // ---------------------------------------------------------------------------

  app.get('/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const account = await getAccount(req.session!.sub!)
    if (!account) {
      return reply.status(404).send({ error: 'Account not found' })
    }

    const adminIds = (process.env.ADMIN_ACCOUNT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)

    return reply.status(200).send({
      id: account.id,
      pubkey: account.nostrPubkey,
      username: account.username,
      displayName: account.displayName,
      bio: account.bio,
      avatar: account.avatarBlossomUrl,
      isWriter: account.isWriter,
      hasPaymentMethod: account.stripeCustomerId !== null,
      stripeConnectKycComplete: account.stripeConnectKycComplete,
      freeAllowanceRemainingPence: account.freeAllowanceRemainingPence,
      defaultArticlePricePence: account.defaultArticlePricePence,
      isAdmin: adminIds.includes(account.id),
    })
  })

  // ---------------------------------------------------------------------------
  // PATCH /auth/profile — update display name, bio, avatar
  // ---------------------------------------------------------------------------

  const UpdateProfileSchema = z.object({
    displayName: z.string().min(1).max(100).optional(),
    bio: z.string().max(500).optional(),
    avatar: z.string().url().max(500).nullable().optional(),
  })

  app.patch('/auth/profile', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = UpdateProfileSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!

    await updateProfile(accountId, {
      displayName: parsed.data.displayName,
      bio: parsed.data.bio,
      avatarBlossomUrl: parsed.data.avatar === null ? null : parsed.data.avatar,
    })

    return reply.status(200).send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // POST /auth/upgrade-writer — start Stripe Connect onboarding
  //
  // Creates a Stripe Connect Express account and returns the onboarding URL.
  // The writer is redirected to Stripe's hosted onboarding flow. When KYC
  // completes, the account.updated webhook (already handled by payment-service)
  // marks stripe_connect_kyc_complete = true.
  // ---------------------------------------------------------------------------

  app.post('/auth/upgrade-writer', { preHandler: requireAuth }, async (req, reply) => {
    const accountId = req.session!.sub!
    const account = await getAccount(accountId)

    if (!account) {
      return reply.status(404).send({ error: 'Account not found' })
    }

    if (account.stripeConnectId) {
      return reply.status(409).send({ error: 'Stripe already connected' })
    }

    try {
      // Create Stripe Connect Express account
      const connectAccount = await stripe.accounts.create({
        type: 'express',
        country: 'GB',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          platform: 'all.haus',
          account_id: accountId,
        },
      })

      // Generate onboarding link
      const accountLink = await stripe.accountLinks.create({
        account: connectAccount.id,
        refresh_url: `${process.env.APP_URL}/settings/payments?refresh=true`,
        return_url: `${process.env.APP_URL}/settings/payments?onboarding=complete`,
        type: 'account_onboarding',
      })

      const result = await connectStripeAccount(accountId, connectAccount.id, accountLink.url)

      return reply.status(200).send(result)
    } catch (err) {
      logger.error({ err, accountId }, 'Writer upgrade failed')
      return reply.status(500).send({ error: 'Failed to start Stripe onboarding' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /auth/connect-card — set up reader payment method
  //
  // Called after Stripe Elements completes card setup on the client.
  // Creates a Stripe Customer (if needed), attaches the payment method,
  // and records the customer ID on the account.
  //
  // This also triggers conversion of provisional reads to accrued
  // (via the payment service's /card-connected endpoint).
  // ---------------------------------------------------------------------------

  const ConnectCardSchema = z.object({
    paymentMethodId: z.string().min(1),
  })

  app.post('/auth/connect-card', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = ConnectCardSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!
    const account = await getAccount(accountId)

    if (!account) {
      return reply.status(404).send({ error: 'Account not found' })
    }

    try {
      let customerId = account.stripeCustomerId

      if (!customerId) {
        // Create Stripe Customer
        const customer = await stripe.customers.create({
          metadata: {
            platform: 'all.haus',
            account_id: accountId,
          },
        })
        customerId = customer.id
      }

      // Attach payment method and set as default
      await stripe.paymentMethods.attach(parsed.data.paymentMethodId, {
        customer: customerId,
      })

      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: parsed.data.paymentMethodId,
        },
      })

      // Record on account
      await connectPaymentMethod(accountId, customerId)

      // Notify payment service to convert provisional reads
      // This is a fire-and-forget internal call — failure is logged, not fatal
      try {
        const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:3001'
        await fetch(`${paymentServiceUrl}/api/v1/card-connected`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ readerId: accountId, stripeCustomerId: customerId }),
        })
      } catch (err) {
        logger.error({ err, accountId }, 'Failed to notify payment service of card connection')
      }

      return reply.status(200).send({ ok: true, hasPaymentMethod: true })
    } catch (err) {
      logger.error({ err, accountId }, 'Card connection failed')
      return reply.status(500).send({ error: 'Failed to connect payment method' })
    }
  })
}
