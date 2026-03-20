import type { FastifyInstance } from 'fastify'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { generateKeypair } from '../../shared/src/auth/keypairs.js'
import { createSession } from '../../shared/src/auth/session.js'
import { getAccount } from '../../shared/src/auth/accounts.js'
import logger from '../../shared/src/lib/logger.js'
import { randomBytes } from 'crypto'

// =============================================================================
// Google OAuth Routes
//
// GET  /auth/google           — redirect to Google's consent screen
// GET  /auth/google/callback  — handle the OAuth callback, create or find
//                               account, set session, redirect to /feed
// =============================================================================

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const appUrl = process.env.APP_URL ?? 'https://platform.pub'
  const redirectUri = `${appUrl}/api/v1/auth/google/callback`

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set')
  }

  return { clientId, clientSecret, redirectUri }
}

export async function googleAuthRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /auth/google — redirect to Google
  // ---------------------------------------------------------------------------

  app.get('/auth/google', async (req, reply) => {
    const { clientId, redirectUri } = getGoogleConfig()

    const state = randomBytes(16).toString('hex')

    reply.setCookie('pp_oauth_state', state, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
    })

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    })

    return reply.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`)
  })

  // ---------------------------------------------------------------------------
  // GET /auth/google/callback — handle OAuth callback
  // ---------------------------------------------------------------------------

  app.get<{
    Querystring: { code?: string; state?: string; error?: string }
  }>('/auth/google/callback', async (req, reply) => {
    const { code, state, error } = req.query
    const appUrl = process.env.APP_URL ?? 'https://platform.pub'

    if (error) {
      logger.warn({ error }, 'Google OAuth error')
      return reply.redirect(`${appUrl}/auth?mode=login&error=google_denied`)
    }

    if (!code || !state) {
      return reply.redirect(`${appUrl}/auth?mode=login&error=google_invalid`)
    }

    const cookies = req.cookies as Record<string, string> | undefined
    const savedState = cookies?.pp_oauth_state
    if (!savedState || savedState !== state) {
      logger.warn('Google OAuth state mismatch')
      return reply.redirect(`${appUrl}/auth?mode=login&error=google_invalid`)
    }

    reply.setCookie('pp_oauth_state', '', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
    })

    try {
      const { clientId, clientSecret, redirectUri } = getGoogleConfig()

      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      })

      if (!tokenRes.ok) {
        const body = await tokenRes.text()
        logger.error({ status: tokenRes.status, body }, 'Google token exchange failed')
        return reply.redirect(`${appUrl}/auth?mode=login&error=google_failed`)
      }

      const tokens = await tokenRes.json() as { id_token?: string }

      if (!tokens.id_token) {
        logger.error('No id_token in Google response')
        return reply.redirect(`${appUrl}/auth?mode=login&error=google_failed`)
      }

      const payload = decodeIdToken(tokens.id_token)

      if (!payload.email) {
        logger.error('No email in Google ID token')
        return reply.redirect(`${appUrl}/auth?mode=login&error=google_failed`)
      }

      const email = payload.email.toLowerCase().trim()
      const name = payload.name ?? email.split('@')[0]

      const existing = await pool.query<{ id: string }>(
        'SELECT id FROM accounts WHERE email = $1',
        [email]
      )

      let accountId: string

      if (existing.rows.length > 0) {
        accountId = existing.rows[0].id
        logger.info({ accountId, email: email.slice(0, 3) + '***' }, 'Google login — existing account')
      } else {
        accountId = await createGoogleAccount(email, name)
        logger.info({ accountId, email: email.slice(0, 3) + '***' }, 'Google login — new account created')
      }

      const account = await getAccount(accountId)
      if (!account) {
        logger.error({ accountId }, 'Account not found after Google login')
        return reply.redirect(`${appUrl}/auth?mode=login&error=google_failed`)
      }

      await createSession(reply, {
        id: account.id,
        nostrPubkey: account.nostrPubkey,
        isWriter: account.isWriter,
      })

      return reply.redirect(`${appUrl}/feed`)

    } catch (err) {
      logger.error({ err }, 'Google OAuth callback failed')
      return reply.redirect(`${appUrl}/auth?mode=login&error=google_failed`)
    }
  })
}

// =============================================================================
// Helpers
// =============================================================================

function decodeIdToken(idToken: string): {
  email?: string
  name?: string
  picture?: string
  sub?: string
} {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('Invalid ID token format')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))

  // Verify issuer, audience, and expiry claims
  const { clientId } = getGoogleConfig()
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('Invalid ID token issuer')
  }
  if (payload.aud !== clientId) {
    throw new Error('Invalid ID token audience')
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('ID token expired')
  }

  return payload
}

async function createGoogleAccount(email: string, displayName: string): Promise<string> {
  const keypair = generateKeypair()

  let baseUsername = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 30)

  if (baseUsername.length < 3) {
    baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30)
  }

  if (baseUsername.length < 3) {
    baseUsername = 'user'
  }

  const suffix = randomBytes(3).toString('hex')
  const username = `${baseUsername}-${suffix}`

  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO accounts (
         nostr_pubkey, nostr_privkey_enc, username, display_name, email,
         is_writer, is_reader, status, free_allowance_remaining_pence
       ) VALUES ($1, $2, $3, $4, $5, FALSE, TRUE, 'active', 500)
       RETURNING id`,
      [keypair.pubkeyHex, keypair.privkeyEncrypted, username, displayName, email]
    )

    const accountId = result.rows[0].id

    await client.query(
      'INSERT INTO reading_tabs (reader_id) VALUES ($1)',
      [accountId]
    )

    return accountId
  })
}
