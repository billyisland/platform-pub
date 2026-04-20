import type { FastifyInstance } from 'fastify'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { generateKeypair } from '../lib/key-custody-client.js'
import { createSession } from '@platform-pub/shared/auth/session.js'
import { getAccount } from '@platform-pub/shared/auth/accounts.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { randomBytes, createHmac, timingSafeEqual } from 'crypto'

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
//   2. Gateway generates an HMAC-signed state, redirects to Google
//   3. Google redirects to ${APP_URL}/auth/google/callback (Next.js page)
//   4. That page POSTs { code, state } to /api/v1/auth/google/exchange
//   5. Gateway verifies state HMAC, exchanges code, sets pp_session cookie
//   6. Page calls /auth/me to hydrate the store, then navigates to /feed
//
// State is verified by HMAC signature (not a cookie) because Next.js rewrite
// proxies do not reliably forward Set-Cookie headers in redirect responses.
// =============================================================================

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const appUrl = process.env.APP_URL ?? 'https://all.haus'

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

    // Use an HMAC-signed state so no cookie is needed.
    // A cookie set in a redirect response is not reliably forwarded by the
    // Next.js rewrite proxy, so we moved state verification server-side.
    const state = generateSignedState()

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
  // Verifies the HMAC-signed state, exchanges the code for tokens, then sets
  // the session cookie in a normal JSON response (not a redirect) so Next.js
  // reliably forwards Set-Cookie to the browser.
  // ---------------------------------------------------------------------------

  app.post<{
    Body: { code: string; state: string }
  }>('/auth/google/exchange', async (req, reply) => {
    const { code, state } = req.body ?? {}

    if (!code || !state) {
      return reply.status(400).send({ error: 'Missing code or state' })
    }

    if (!verifySignedState(state)) {
      logger.warn('Google OAuth state verification failed in exchange')
      return reply.status(400).send({ error: 'State mismatch' })
    }

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

// ---------------------------------------------------------------------------
// HMAC-signed OAuth state — avoids setting a cookie in a redirect response,
// which Next.js rewrite proxies don't reliably forward to the browser.
//
// Format: <nonce>.<timestamp>.<hmac-sha256-hex>
// The exchange endpoint verifies the HMAC and that the token is not expired.
// ---------------------------------------------------------------------------

function getStateSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET not set')
  return secret
}

function generateSignedState(): string {
  const nonce = randomBytes(16).toString('hex')
  const timestamp = Math.floor(Date.now() / 1000)
  const payload = `${nonce}.${timestamp}`
  const sig = createHmac('sha256', getStateSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function verifySignedState(state: string, maxAgeSeconds = 600): boolean {
  const parts = state.split('.')
  if (parts.length !== 3) return false
  const [nonce, ts, sig] = parts
  const timestamp = parseInt(ts, 10)
  if (isNaN(timestamp)) return false
  if (Math.floor(Date.now() / 1000) - timestamp > maxAgeSeconds) return false
  const payload = `${nonce}.${ts}`
  const expectedSig = createHmac('sha256', getStateSecret()).update(payload).digest()
  const sigBuf = Buffer.from(sig, 'hex')
  if (sigBuf.length !== expectedSig.length) return false
  return timingSafeEqual(sigBuf, expectedSig)
}

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
