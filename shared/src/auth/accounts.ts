import { z } from 'zod'
import { pool, withTransaction } from '../db/client.js'
import { createSession, destroySession } from './session.js'
import logger from '../lib/logger.js'
import type { FastifyReply } from 'fastify'

// =============================================================================
// Account Service
//
// Handles account creation (signup), authentication, and Stripe Connect
// onboarding for writers.
//
// Signup flow (per ADR):
//   1. User provides email + display name (or just arrives and clicks "read")
//   2. Platform generates a custodial Nostr keypair
//   3. Account created with is_reader=true, free_allowance=500 (£5)
//   4. Reading tab created (one per reader)
//   5. Session cookie set
//
// Writer upgrade:
//   A reader becomes a writer by toggling is_writer=true and completing
//   Stripe Connect onboarding. The keypair is already generated.
//
// Authentication:
//   At launch, email + magic link (passwordless). The Nostr keypair is
//   custodial — we don't ask users to manage keys.
//
// Future: NIP-07 browser extension login for users who self-custody keys.
// =============================================================================

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const SignupSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  username: z.string().min(3).max(40).regex(/^[a-z0-9_-]+$/, {
    message: 'Username must be lowercase alphanumeric, hyphens, or underscores',
  }),
})

export type SignupInput = z.infer<typeof SignupSchema>

// ---------------------------------------------------------------------------
// signup — creates a new account with custodial keypair
// ---------------------------------------------------------------------------

export interface SignupResult {
  accountId: string
  pubkey: string
  username: string
}

export async function signup(
  input: SignupInput,
  reply: FastifyReply,
  keypair: { pubkeyHex: string; privkeyEncrypted: string }
): Promise<SignupResult> {
  return withTransaction(async (client) => {
    // Create account
    const accountRow = await client.query<{
      id: string
      nostr_pubkey: string
      username: string
    }>(
      `INSERT INTO accounts (
         nostr_pubkey, nostr_privkey_enc, username, display_name, email,
         is_writer, is_reader, status, free_allowance_remaining_pence
       ) VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, 'active', 500)
       RETURNING id, nostr_pubkey, username`,
      [keypair.pubkeyHex, keypair.privkeyEncrypted, input.username, input.displayName, input.email.toLowerCase().trim()]
    )

    const account = accountRow.rows[0]

    // Create reading tab (one per reader — the tab tracks their running balance)
    await client.query(
      'INSERT INTO reading_tabs (reader_id) VALUES ($1)',
      [account.id]
    )

    // Set session cookie
    await createSession(reply, {
      id: account.id,
      nostrPubkey: account.nostr_pubkey,
      isWriter: false,
    })

    logger.info(
      { accountId: account.id, username: input.username },
      'Account created'
    )

    return {
      accountId: account.id,
      pubkey: account.nostr_pubkey,
      username: account.username,
    }
  })
}

// ---------------------------------------------------------------------------
// connectStripeAccount — stores Stripe Connect ID for payouts
// ---------------------------------------------------------------------------

export interface StripeConnectResult {
  stripeConnectUrl: string   // Stripe Connect onboarding URL — redirect the user here
}

export async function connectStripeAccount(
  accountId: string,
  stripeAccountId: string,
  onboardingUrl: string
): Promise<StripeConnectResult> {
  await pool.query(
    `UPDATE accounts
     SET stripe_connect_id = $1,
         updated_at = now()
     WHERE id = $2`,
    [stripeAccountId, accountId]
  )

  logger.info({ accountId, stripeAccountId }, 'Stripe Connect onboarding started')

  return { stripeConnectUrl: onboardingUrl }
}

// ---------------------------------------------------------------------------
// getAccount — fetch account by ID (for session hydration)
// ---------------------------------------------------------------------------

export interface AccountInfo {
  id: string
  nostrPubkey: string
  username: string | null
  displayName: string | null
  bio: string | null
  avatarBlossomUrl: string | null
  isWriter: boolean
  isReader: boolean
  status: string
  stripeCustomerId: string | null
  stripeConnectId: string | null
  stripeConnectKycComplete: boolean
  freeAllowanceRemainingPence: number
  defaultArticlePricePence: number | null
}

export async function getAccount(accountId: string): Promise<AccountInfo | null> {
  const { rows } = await pool.query<{
    id: string
    nostr_pubkey: string
    username: string | null
    display_name: string | null
    bio: string | null
    avatar_blossom_url: string | null
    is_writer: boolean
    is_reader: boolean
    status: string
    stripe_customer_id: string | null
    stripe_connect_id: string | null
    stripe_connect_kyc_complete: boolean
    free_allowance_remaining_pence: number
    default_article_price_pence: number | null
  }>(
    `SELECT id, nostr_pubkey, username, display_name, bio, avatar_blossom_url,
            is_writer, is_reader, status, stripe_customer_id, stripe_connect_id,
            stripe_connect_kyc_complete, free_allowance_remaining_pence,
            default_article_price_pence
     FROM accounts WHERE id = $1`,
    [accountId]
  )

  if (rows.length === 0) return null

  const r = rows[0]
  return {
    id: r.id,
    nostrPubkey: r.nostr_pubkey,
    username: r.username,
    displayName: r.display_name,
    bio: r.bio,
    avatarBlossomUrl: r.avatar_blossom_url,
    isWriter: r.is_writer,
    isReader: r.is_reader,
    status: r.status,
    stripeCustomerId: r.stripe_customer_id,
    stripeConnectId: r.stripe_connect_id,
    stripeConnectKycComplete: r.stripe_connect_kyc_complete,
    freeAllowanceRemainingPence: r.free_allowance_remaining_pence,
    defaultArticlePricePence: r.default_article_price_pence,
  }
}

// ---------------------------------------------------------------------------
// updateProfile — update display name, bio, and/or avatar
// ---------------------------------------------------------------------------

export async function updateProfile(
  accountId: string,
  updates: { displayName?: string; bio?: string; avatarBlossomUrl?: string | null }
): Promise<void> {
  const setParts: string[] = []
  const values: any[] = []
  let i = 1

  if (updates.displayName !== undefined) {
    setParts.push(`display_name = $${i++}`)
    values.push(updates.displayName)
  }
  if (updates.bio !== undefined) {
    setParts.push(`bio = $${i++}`)
    values.push(updates.bio)
  }
  if (updates.avatarBlossomUrl !== undefined) {
    setParts.push(`avatar_blossom_url = $${i++}`)
    values.push(updates.avatarBlossomUrl)
  }

  if (setParts.length === 0) return

  values.push(accountId)
  await pool.query(
    `UPDATE accounts SET ${setParts.join(', ')}, updated_at = now() WHERE id = $${i}`,
    values
  )

  logger.info({ accountId }, 'Profile updated')
}

// ---------------------------------------------------------------------------
// connectPaymentMethod — records a reader's Stripe customer ID
// Called after Stripe Elements card setup succeeds.
// ---------------------------------------------------------------------------

export async function connectPaymentMethod(
  accountId: string,
  stripeCustomerId: string
): Promise<void> {
  await pool.query(
    `UPDATE accounts
     SET stripe_customer_id = $1, updated_at = now()
     WHERE id = $2`,
    [stripeCustomerId, accountId]
  )

  logger.info({ accountId }, 'Payment method connected')
}
