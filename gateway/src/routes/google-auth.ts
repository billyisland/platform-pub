import type { FastifyInstance } from 'fastify'
import { pool, withTransaction } from '../../shared/src/db/client.js'
import { generateKeypair } from '../lib/key-custody-client.js'
import { createSession } from '../../shared/src/auth/session.js'
import { getAccount } from '../../shared/src/auth/accounts.js'
import logger from '../../shared/src/lib/logger.js'
import { randomBytes } from 'crypto'

// =============================================================================
// Google OAuth Routes
//
// GET  /auth/google          — redirect to Google's consent screen
// POST /auth/google/exchange — called by the frontend callback page after
//                              Google redirects back; validates state, exchanges
//                              code, creates or finds account, sets session cookie
//
// Flow:
//   1. Browser clicks "Continue with Google" → GET /api/v1/auth/google
//   2. Gateway sets pp_oauth_state cookie, redirects to Google
//   3. Google redirects to ${APP_URL}/auth/google/callback (Next.js page)
//   4. That page POSTs { code, state } to /api/v1/auth/google/exchange
//   5. Gateway validates state cookie, exchanges code, sets pp_session cookie
//   6. Page calls /auth/me to hydrate the store, then navigates to /feed
//
// This avoids setting a session cookie inside a redirect response, which
// Next.js rewrite proxies do not reliably forward to the browser.
// =============================================================================

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const appUrl = process.env.APP_URL ?? 'https://platform.pub'

  // The redirect_uri must point to the Next.js callback page (not a proxied
  // gateway route) so Google lands the browser directly on the frontend.
  const redirectUri = `${appUrl}/auth/google/callback`

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
  // POST /auth/google/exchange — complete OAuth from the frontend callback page
  //
  // Called with credentials (cookies) so the pp_oauth_state cookie is present.
  // Sets the pp_session cookie in the response body — a normal JSON response,
  // not a redirect, so Next.js reliably forwards Set-Cookie to the browser.
  // ---------------------------------------------------------------------------

  app.post<{
    Body: { code: string; state: string }
  }>('/auth/google/exchange', async (req, reply) => {
    const { code, state } = req.body ?? {}

    if (!code || !state) {
      return reply.status(400).send({ error: 'Missing code or state' })
    }

    const cookies = req.cookies as Record<string, string> | undefined
    const savedState = cookies?.pp_oauth_state
    if (!savedState || savedState !== state) {
      logger.warn('Google OAuth state mismatch in exchange')
      return reply.status(400).send({ error: 'State mismatch' })
    }

    // Clear the one-time state cookie
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
        return reply.status(400).send({ error: 'Token exchange failed' })
      }

      const tokens = await tokenRes.json() as { id_token?: string }

      if (!tokens.id_token) {
        logger.error('No id_token in Google response')
        return reply.status(400).send({ error: 'No id_token' })
      }

      const payload = decodeIdToken(tokens.id_token)

      if (!payload.email) {
        logger.error('No email in Google ID token')
        return reply.status(400).send({ error: 'No email in token' })
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
        return reply.status(500).send({ error: 'Account not found' })
      }

      await createSession(reply, {
        id: account.id,
        nostrPubkey: account.nostrPubkey,
        isWriter: account.isWriter,
      })

      return reply.status(200).send({ ok: true })

    } catch (err) {
      logger.error({ err }, 'Google OAuth exchange failed')
      return reply.status(500).send({ error: 'Exchange failed' })
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
  const keypair = await generateKeypair()

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

  // Use base username if available, otherwise append a random suffix
  let username = baseUsername
  const { rows: existing } = await pool.query<{ username: string }>(
    `SELECT username FROM accounts WHERE username = $1 OR username LIKE $2 ORDER BY username`,
    [baseUsername, `${baseUsername}-%`]
  )
  if (existing.some(r => r.username === baseUsername)) {
    const taken = new Set(existing.map(r => r.username))
    do { username = `${baseUsername}-${randomBytes(3).toString('hex')}` } while (taken.has(username))
  }

  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO accounts (
         nostr_pubkey, nostr_privkey_enc, username, display_name, email,
         is_writer, is_reader, status, free_allowance_remaining_pence
       ) VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, 'active', 500)
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
