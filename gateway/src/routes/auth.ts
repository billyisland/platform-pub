import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { signup, SignupSchema, getAccount, updateProfile, connectStripeAccount, connectPaymentMethod } from '@platform-pub/shared/auth/accounts.js'
import { createSession, destroySession, verifySession } from '@platform-pub/shared/auth/session.js'
import { requestMagicLink, verifyMagicLink } from '@platform-pub/shared/auth/magic-links.js'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { sendMagicLinkEmail, sendEmail } from '@platform-pub/shared/lib/email.js'
import { requireAuth } from '../middleware/auth.js'
import { generateKeypair, signEvent } from '../lib/key-custody-client.js'
import { publishToRelay } from '../lib/nostr-publisher.js'
import Stripe from 'stripe'
import logger from '@platform-pub/shared/lib/logger.js'
import { requireEnv } from '@platform-pub/shared/lib/env.js'
import crypto from 'crypto'

// =============================================================================
// Auth Routes — mounted on the gateway
//
// POST /auth/signup              — create account (email, username, displayName)
// POST /auth/login               — magic link login (sends email)
// POST /auth/verify              — verify magic link token → set session
// POST /auth/logout              — clear session
// GET  /auth/me                  — current account info (session hydration)
// POST /auth/upgrade-writer      — start Stripe Connect onboarding
// POST /auth/connect-card        — save reader payment method
// POST /auth/deactivate          — deactivate account (reversible)
// POST /auth/delete-account      — permanently delete account
// POST /auth/change-email        — request email change (sends verification)
// POST /auth/verify-email-change — verify email change token
// POST /auth/change-username     — change username (30-day cooldown)
// GET  /auth/check-username/:u   — check username availability
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
    // If we have a valid session, invalidate all sessions for this account
    const session = await verifySession(req)
    if (session?.sub) {
      await pool.query(
        'UPDATE accounts SET sessions_invalidated_at = now() WHERE id = $1',
        [session.sub]
      )
    }
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
      email: account.email,
      isWriter: account.isWriter,
      hasPaymentMethod: account.stripeCustomerId !== null,
      stripeConnectKycComplete: account.stripeConnectKycComplete,
      freeAllowanceRemainingPence: account.freeAllowanceRemainingPence,
      defaultArticlePricePence: account.defaultArticlePricePence,
      isAdmin: adminIds.includes(account.id),
      usernameChangedAt: account.usernameChangedAt,
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

  // ---------------------------------------------------------------------------
  // POST /auth/deactivate — deactivate account (reversible)
  //
  // Sets account status to 'deactivated' and destroys the session.
  // The user can reactivate by logging back in (magic link still works
  // for deactivated accounts — the verify route should handle reactivation).
  // ---------------------------------------------------------------------------

  app.post('/auth/deactivate', { preHandler: requireAuth }, async (req, reply) => {
    const accountId = req.session!.sub!

    await pool.query(
      `UPDATE accounts SET status = 'deactivated', updated_at = now() WHERE id = $1`,
      [accountId]
    )

    logger.info({ accountId }, 'Account deactivated')
    destroySession(reply)
    return reply.status(200).send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // POST /auth/delete-account — permanently delete account
  //
  // Requires the user to confirm by submitting their email address.
  // Cancels subscriptions, soft-deletes articles (with kind-5 events),
  // and hard-deletes the account row (CASCADE handles related records).
  // ---------------------------------------------------------------------------

  const DeleteAccountSchema = z.object({
    emailConfirmation: z.string().email(),
  })

  app.post('/auth/delete-account', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = DeleteAccountSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!

    // Verify the email matches
    const { rows: accountRows } = await pool.query<{ email: string }>(
      'SELECT email FROM accounts WHERE id = $1',
      [accountId]
    )
    if (accountRows.length === 0) {
      return reply.status(404).send({ error: 'Account not found' })
    }
    if (accountRows[0].email.toLowerCase() !== parsed.data.emailConfirmation.toLowerCase()) {
      return reply.status(400).send({ error: 'Email does not match' })
    }

    await withTransaction(async (client) => {
      // Cancel all active subscriptions (as reader)
      await client.query(
        `UPDATE subscriptions SET status = 'cancelled', cancelled_at = now()
         WHERE reader_id = $1 AND status = 'active'`,
        [accountId]
      )

      // Cancel all active subscriptions (as writer — subscribers lose access)
      await client.query(
        `UPDATE subscriptions SET status = 'cancelled', cancelled_at = now()
         WHERE writer_id = $1 AND status = 'active'`,
        [accountId]
      )

      // Soft-delete all articles and collect event IDs for kind-5 deletion
      const { rows: articles } = await client.query<{ id: string; nostr_event_id: string; nostr_d_tag: string }>(
        `UPDATE articles SET deleted_at = now()
         WHERE writer_id = $1 AND deleted_at IS NULL
         RETURNING id, nostr_event_id, nostr_d_tag`,
        [accountId]
      )

      // Publish kind 5 deletion events (non-fatal — DB is source of truth)
      for (const article of articles) {
        try {
          const deletionEvent = await signEvent(accountId, {
            kind: 5,
            content: '',
            tags: [
              ['e', article.nostr_event_id],
              ['a', `30023:${accountRows[0].email}:${article.nostr_d_tag}`],
            ],
            created_at: Math.floor(Date.now() / 1000),
          })
          await publishToRelay(deletionEvent as any)
        } catch (err) {
          logger.error({ err, articleId: article.id }, 'Failed to publish kind 5 deletion event during account deletion')
        }
      }

      // Hard-delete the account (CASCADE handles bookmarks, follows, etc.)
      await client.query('DELETE FROM accounts WHERE id = $1', [accountId])

      logger.info({ accountId, articlesDeleted: articles.length }, 'Account permanently deleted')
    })

    destroySession(reply)
    return reply.status(200).send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // POST /auth/change-email — request email change
  //
  // Stores the new email in pending_email with a verification token.
  // Sends a verification link to the new address. The current email
  // remains active until the verification link is clicked.
  // ---------------------------------------------------------------------------

  const ChangeEmailSchema = z.object({
    newEmail: z.string().email(),
  })

  app.post('/auth/change-email', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = ChangeEmailSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!
    const newEmail = parsed.data.newEmail.toLowerCase().trim()

    // Check if email is already in use
    const { rows: existing } = await pool.query(
      'SELECT id FROM accounts WHERE email = $1 AND id != $2',
      [newEmail, accountId]
    )
    if (existing.length > 0) {
      return reply.status(409).send({ error: 'Email already in use' })
    }

    // Generate verification token
    const token = crypto.randomBytes(32).toString('base64url')

    await pool.query(
      `UPDATE accounts SET pending_email = $1, email_verification_token = $2, updated_at = now()
       WHERE id = $3`,
      [newEmail, token, accountId]
    )

    // Send verification email to the new address
    const appUrl = process.env.APP_URL ?? 'http://localhost:3010'
    const verifyUrl = `${appUrl}/auth/verify?emailChange=${encodeURIComponent(token)}`

    try {
      await sendEmail({
        to: newEmail,
        subject: 'Verify your new email — all.haus',
        textBody: [
          'Click this link to verify your new email address on all.haus:',
          '',
          verifyUrl,
          '',
          'If you didn\'t request this change, you can ignore this email.',
        ].join('\n'),
        htmlBody: `
          <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
            <h2 style="font-size: 20px; font-weight: 600; color: #1c1917; margin-bottom: 16px;">
              Verify your new email
            </h2>
            <p style="font-size: 15px; color: #57534e; line-height: 1.6; margin-bottom: 24px;">
              Click the button below to confirm this as your new email address on all.haus.
            </p>
            <a href="${verifyUrl}"
               style="display: inline-block; background: #1c1917; color: #ffffff; font-size: 14px; font-weight: 500; padding: 12px 28px; text-decoration: none;">
              Verify email
            </a>
            <p style="font-size: 13px; color: #a8a29e; margin-top: 32px; line-height: 1.5;">
              If you didn't request this change, you can safely ignore this email.
            </p>
          </div>`,
      })
    } catch (err) {
      logger.error({ err, accountId }, 'Failed to send email change verification')
      return reply.status(500).send({ error: 'Failed to send verification email' })
    }

    logger.info({ accountId, newEmail: newEmail.slice(0, 3) + '***' }, 'Email change requested')
    return reply.status(200).send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // POST /auth/verify-email-change — verify email change token
  //
  // Swaps the pending email into the email field and clears the pending fields.
  // ---------------------------------------------------------------------------

  const VerifyEmailChangeSchema = z.object({
    token: z.string().min(1),
  })

  app.post('/auth/verify-email-change', async (req, reply) => {
    const parsed = VerifyEmailChangeSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { rows } = await pool.query<{ id: string; pending_email: string }>(
      `SELECT id, pending_email FROM accounts
       WHERE email_verification_token = $1 AND pending_email IS NOT NULL`,
      [parsed.data.token]
    )

    if (rows.length === 0) {
      return reply.status(400).send({ error: 'Invalid or expired verification token' })
    }

    const { id: accountId, pending_email: newEmail } = rows[0]

    // Check the new email hasn't been taken since the request was made
    const { rows: conflict } = await pool.query(
      'SELECT id FROM accounts WHERE email = $1 AND id != $2',
      [newEmail, accountId]
    )
    if (conflict.length > 0) {
      await pool.query(
        `UPDATE accounts SET pending_email = NULL, email_verification_token = NULL WHERE id = $1`,
        [accountId]
      )
      return reply.status(409).send({ error: 'Email already in use' })
    }

    await pool.query(
      `UPDATE accounts SET email = $1, pending_email = NULL, email_verification_token = NULL, updated_at = now()
       WHERE id = $2`,
      [newEmail, accountId]
    )

    logger.info({ accountId }, 'Email changed successfully')
    return reply.status(200).send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // POST /auth/change-username — change username (30-day cooldown)
  //
  // Validates format, checks availability, enforces 30-day cooldown,
  // and sets up a 90-day redirect from the old username.
  // ---------------------------------------------------------------------------

  const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/

  const ChangeUsernameSchema = z.object({
    newUsername: z.string().min(3).max(30),
  })

  app.post('/auth/change-username', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = ChangeUsernameSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!
    const newUsername = parsed.data.newUsername.toLowerCase()

    if (!USERNAME_RE.test(newUsername)) {
      return reply.status(400).send({ error: 'Username must be 3-30 characters, lowercase alphanumeric and hyphens only' })
    }

    const { rows: account } = await pool.query<{
      username: string | null
      username_changed_at: Date | null
    }>(
      'SELECT username, username_changed_at FROM accounts WHERE id = $1',
      [accountId]
    )

    if (account.length === 0) {
      return reply.status(404).send({ error: 'Account not found' })
    }

    // 30-day cooldown
    if (account[0].username_changed_at) {
      const daysSince = (Date.now() - account[0].username_changed_at.getTime()) / (1000 * 60 * 60 * 24)
      if (daysSince < 30) {
        const nextChangeDate = new Date(account[0].username_changed_at.getTime() + 30 * 24 * 60 * 60 * 1000)
        return reply.status(429).send({
          error: 'Username change cooldown active',
          nextChangeDate: nextChangeDate.toISOString(),
        })
      }
    }

    // Check availability
    const { rows: existing } = await pool.query(
      'SELECT id FROM accounts WHERE username = $1 AND id != $2',
      [newUsername, accountId]
    )
    if (existing.length > 0) {
      return reply.status(409).send({ error: 'Username already taken' })
    }

    const oldUsername = account[0].username

    await pool.query(
      `UPDATE accounts
       SET username = $1,
           previous_username = $2,
           username_redirect_until = now() + INTERVAL '90 days',
           username_changed_at = now(),
           updated_at = now()
       WHERE id = $3`,
      [newUsername, oldUsername, accountId]
    )

    logger.info({ accountId, oldUsername, newUsername }, 'Username changed')
    return reply.status(200).send({ ok: true, username: newUsername })
  })

  // ---------------------------------------------------------------------------
  // GET /auth/check-username/:username — check username availability
  // ---------------------------------------------------------------------------

  app.get<{ Params: { username: string } }>(
    '/auth/check-username/:username',
    { preHandler: requireAuth },
    async (req, reply) => {
      const username = req.params.username.toLowerCase()

      if (!USERNAME_RE.test(username)) {
        return reply.status(200).send({ available: false, reason: 'Invalid format' })
      }

      const accountId = req.session!.sub!
      const { rows } = await pool.query(
        'SELECT id FROM accounts WHERE username = $1 AND id != $2',
        [username, accountId]
      )

      return reply.status(200).send({ available: rows.length === 0 })
    }
  )
}
