import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { z } from 'zod'
import { pool } from '../../shared/src/db/client.js'
import { safeFetch } from '../../shared/src/lib/http-client.js'
import { encryptJson, decryptJson } from '../../shared/src/lib/crypto.js'
import { getAtprotoClient } from '../../shared/src/lib/atproto-oauth.js'
import { getProfile, isDid, normaliseHandle } from '../lib/atproto-resolve.js'
import { requireAuth } from '../middleware/auth.js'
import { requireEnv } from '../../shared/src/lib/env.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Linked Accounts (Phase 5 — outbound reply router)
//
// GET    /linked-accounts              — list current user's linked accounts
// DELETE /linked-accounts/:id          — disconnect one
// PATCH  /linked-accounts/:id          — update cross_post_default
// POST   /linked-accounts/mastodon     — begin Mastodon OAuth flow (returns authorize URL)
// GET    /linked-accounts/callback     — Mastodon OAuth callback
// POST   /linked-accounts/bluesky      — begin AT Protocol OAuth flow (returns authorize URL)
// GET    /linked-accounts/bluesky/callback — AT Protocol OAuth callback
//
// Bluesky uses @atproto/oauth-client-node (PKCE + DPoP + PAR). The library
// handles all crypto and stores session state in atproto_oauth_sessions via
// our DB-backed SimpleStore (see shared/src/lib/atproto-oauth.ts).
//
// External Nostr outbound uses the user's custodial key via key-custody (no
// OAuth; enqueueNostrOutbound handles relay publishing directly).
// =============================================================================

const APP_URL = requireEnv('APP_URL')
// Callback is the user's own browser returning to all.haus, so we can piggy-back
// on the existing session cookie. The Fastify cookie plugin signs state with
// SESSION_SECRET automatically when `signed: true` is set.
const CALLBACK_PATH = '/api/v1/linked-accounts/callback'

const MASTODON_SCOPES = 'read:accounts write:statuses'
const CLIENT_NAME = 'all.haus'

// ---- Mastodon API shapes we care about --------------------------------------

interface MastodonAppResponse {
  id: string
  client_id: string
  client_secret: string
}

interface MastodonTokenResponse {
  access_token: string
  token_type: string
  scope: string
  created_at: number
}

interface MastodonVerifyCredentialsResponse {
  id: string
  username: string
  acct: string                 // user@instance for remote, user for local
  display_name: string
  avatar: string
  url: string
}

// ---- Route handlers ---------------------------------------------------------

export async function linkedAccountsRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /linked-accounts — list user's linked accounts (public-safe fields only)
  // ---------------------------------------------------------------------------

  app.get('/linked-accounts', { preHandler: requireAuth }, async (req) => {
    const userId = req.session!.sub!
    const { rows } = await pool.query<{
      id: string
      protocol: string
      external_id: string
      external_handle: string | null
      instance_url: string | null
      is_valid: boolean
      cross_post_default: boolean
      token_expires_at: Date | null
      created_at: Date
    }>(`
      SELECT id, protocol, external_id, external_handle, instance_url,
             is_valid, cross_post_default, token_expires_at, created_at
      FROM linked_accounts
      WHERE account_id = $1
      ORDER BY created_at DESC
    `, [userId])

    return {
      accounts: rows.map(r => ({
        id: r.id,
        protocol: r.protocol,
        externalId: r.external_id,
        externalHandle: r.external_handle,
        instanceUrl: r.instance_url,
        isValid: r.is_valid,
        crossPostDefault: r.cross_post_default,
        tokenExpiresAt: r.token_expires_at,
        createdAt: r.created_at,
      })),
    }
  })

  // ---------------------------------------------------------------------------
  // DELETE /linked-accounts/:id — disconnect
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    '/linked-accounts/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const { rowCount } = await pool.query(
        `DELETE FROM linked_accounts WHERE id = $1 AND account_id = $2`,
        [req.params.id, userId]
      )
      if (rowCount === 0) return reply.status(404).send({ error: 'Not found' })
      return { ok: true }
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /linked-accounts/:id — update cross_post_default
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string }; Body: { crossPostDefault?: boolean } }>(
    '/linked-accounts/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const body = z.object({ crossPostDefault: z.boolean() }).safeParse(req.body)
      if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

      const { rowCount } = await pool.query(
        `UPDATE linked_accounts
           SET cross_post_default = $3, updated_at = now()
         WHERE id = $1 AND account_id = $2`,
        [req.params.id, userId, body.data.crossPostDefault]
      )
      if (rowCount === 0) return reply.status(404).send({ error: 'Not found' })
      return { ok: true }
    }
  )

  // ---------------------------------------------------------------------------
  // POST /linked-accounts/mastodon — begin OAuth flow
  //
  // Body: { instanceUrl }
  // Returns: { authorizeUrl } — the frontend redirects the user there.
  //
  // Steps:
  //   1. Validate instance URL (must be https, non-private IP — safeFetch enforces)
  //   2. Look up or register OAuth app for that instance
  //   3. Generate a signed state cookie (nonce + instanceUrl)
  //   4. Return the authorize URL
  // ---------------------------------------------------------------------------

  app.post<{ Body: { instanceUrl: string } }>(
    '/linked-accounts/mastodon',
    { preHandler: requireAuth },
    async (req, reply) => {
      const schema = z.object({ instanceUrl: z.string().min(1) })
      const parsed = schema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

      let instance: URL
      try {
        instance = new URL(parsed.data.instanceUrl.startsWith('http')
          ? parsed.data.instanceUrl
          : `https://${parsed.data.instanceUrl}`)
      } catch {
        return reply.status(400).send({ error: 'Invalid instance URL' })
      }
      if (instance.protocol !== 'https:') {
        return reply.status(400).send({ error: 'Instance must use https' })
      }
      const instanceOrigin = instance.origin

      const redirectUri = `${APP_URL}${CALLBACK_PATH}`

      // Find or register app credentials for this instance.
      let appCreds: { clientId: string; clientSecret: string }
      try {
        appCreds = await getOrRegisterMastodonApp(instanceOrigin, redirectUri)
      } catch (err) {
        logger.warn({ err, instance: instanceOrigin }, 'Mastodon app registration failed')
        return reply.status(502).send({ error: 'Could not register with that Mastodon instance' })
      }

      // Signed state cookie — ties the callback to this user + instance + protocol.
      const nonce = crypto.randomBytes(16).toString('hex')
      reply.setCookie('oauth_state', JSON.stringify({
        protocol: 'activitypub',
        instance: instanceOrigin,
        nonce,
      }), {
        signed: true,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: APP_URL.startsWith('https://'),
        maxAge: 600, // 10 min
      })

      const authorizeUrl = new URL(`${instanceOrigin}/oauth/authorize`)
      authorizeUrl.searchParams.set('client_id', appCreds.clientId)
      authorizeUrl.searchParams.set('redirect_uri', redirectUri)
      authorizeUrl.searchParams.set('response_type', 'code')
      authorizeUrl.searchParams.set('scope', MASTODON_SCOPES)
      authorizeUrl.searchParams.set('state', nonce)

      return { authorizeUrl: authorizeUrl.toString() }
    }
  )

  // ---------------------------------------------------------------------------
  // GET /linked-accounts/callback — handles Mastodon OAuth return
  //
  // Reads the state cookie, exchanges the code for a token, fetches the
  // user's external identity, and upserts linked_accounts.
  // Always redirects to /settings with a query flag indicating outcome.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/linked-accounts/callback',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const { code, state, error } = req.query

      const redirectOk = (flag: string) =>
        reply.redirect(`${APP_URL}/settings?linked=${encodeURIComponent(flag)}`)

      if (error || !code || !state) {
        return redirectOk('error')
      }

      // Verify signed state cookie
      const rawCookie = req.cookies.oauth_state
      if (!rawCookie) return redirectOk('error')
      const unsigned = reply.unsignCookie(rawCookie)
      if (!unsigned.valid || !unsigned.value) return redirectOk('error')
      reply.clearCookie('oauth_state', { path: '/' })

      let statePayload: { protocol: string; instance: string; nonce: string }
      try {
        statePayload = JSON.parse(unsigned.value)
      } catch {
        return redirectOk('error')
      }
      if (statePayload.nonce !== state) return redirectOk('error')

      if (statePayload.protocol !== 'activitypub') {
        return redirectOk('error')
      }

      try {
        const { clientId, clientSecret } = await getStoredMastodonApp(statePayload.instance)
        const redirectUri = `${APP_URL}${CALLBACK_PATH}`
        const token = await exchangeMastodonCode({
          instance: statePayload.instance,
          clientId,
          clientSecret,
          code,
          redirectUri,
        })
        const profile = await fetchMastodonProfile(statePayload.instance, token.access_token)

        const credentialsEnc = encryptJson({
          accessToken: token.access_token,
          tokenType: token.token_type,
          scope: token.scope,
        })

        await pool.query(`
          INSERT INTO linked_accounts (
            account_id, protocol, external_id, external_handle,
            instance_url, credentials_enc, is_valid,
            last_refreshed_at, updated_at
          ) VALUES ($1, 'activitypub', $2, $3, $4, $5, TRUE, now(), now())
          ON CONFLICT (account_id, protocol, external_id)
          DO UPDATE SET
            external_handle   = EXCLUDED.external_handle,
            instance_url      = EXCLUDED.instance_url,
            credentials_enc   = EXCLUDED.credentials_enc,
            is_valid          = TRUE,
            last_refreshed_at = now(),
            updated_at        = now()
        `, [
          userId,
          profile.id,
          profile.acct.includes('@') ? profile.acct : `${profile.username}@${new URL(statePayload.instance).hostname}`,
          statePayload.instance,
          credentialsEnc,
        ])

        logger.info({ userId, instance: statePayload.instance, externalId: profile.id }, 'Mastodon account linked')
        return redirectOk('mastodon')
      } catch (err) {
        logger.warn({ err, userId }, 'Mastodon OAuth callback failed')
        return redirectOk('error')
      }
    }
  )

  // ---------------------------------------------------------------------------
  // POST /linked-accounts/bluesky — begin AT Protocol OAuth flow
  //
  // Body: { handle }  — a Bluesky handle or DID (bsky.app/profile/... accepted)
  // Returns: { authorizeUrl } — frontend redirects the user.
  //
  // NodeOAuthClient.authorize() takes an identifier (handle or DID), resolves
  // it to a PDS + authorization server, does PAR + PKCE + DPoP, and returns
  // the URL to send the user to.
  // ---------------------------------------------------------------------------

  app.post<{ Body: { handle: string } }>(
    '/linked-accounts/bluesky',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const parsed = z.object({ handle: z.string().min(1).max(256) }).safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

      let identifier = parsed.data.handle.trim()
      try {
        const asUrl = new URL(identifier)
        if (asUrl.hostname === 'bsky.app' || asUrl.hostname === 'staging.bsky.app') {
          const m = asUrl.pathname.match(/^\/profile\/([^\/]+)/)
          if (m) identifier = decodeURIComponent(m[1])
        }
      } catch {
        // not a URL, treat as handle
      }
      if (!isDid(identifier)) identifier = normaliseHandle(identifier)

      // Stash the user id in a signed cookie so the callback can find them.
      // (State also flows through NodeOAuthClient, but the callback needs to
      // know which all.haus account to attach the DID to.)
      const nonce = crypto.randomBytes(16).toString('hex')
      reply.setCookie('oauth_state', JSON.stringify({
        protocol: 'atproto',
        userId,
        nonce,
      }), {
        signed: true,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: APP_URL.startsWith('https://'),
        maxAge: 600,
      })

      try {
        const client = await getAtprotoClient()
        const url = await client.authorize(identifier, { state: nonce, scope: 'atproto transition:generic' })
        return { authorizeUrl: url.toString() }
      } catch (err) {
        logger.warn({ err, identifier }, 'Bluesky OAuth authorize() failed')
        return reply.status(502).send({ error: 'Could not start Bluesky OAuth — check the handle is valid' })
      }
    }
  )

  // ---------------------------------------------------------------------------
  // GET /linked-accounts/bluesky/callback — AT Protocol OAuth return
  //
  // NodeOAuthClient.callback(params) verifies state, exchanges code (with DPoP
  // proof), stores the session via our SessionStore, and returns the OAuthSession.
  // We then look up the user from the signed cookie and insert a linked_accounts
  // row with external_id = did, credentials_enc = NULL (the @atproto lib owns
  // the token storage in atproto_oauth_sessions).
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: Record<string, string> }>(
    '/linked-accounts/bluesky/callback',
    async (req, reply) => {
      const redirectOk = (flag: string) =>
        reply.redirect(`${APP_URL}/settings?linked=${encodeURIComponent(flag)}`)

      // Read + verify our cookie first — it carries the all.haus user id.
      const rawCookie = req.cookies.oauth_state
      if (!rawCookie) return redirectOk('error')
      const unsigned = reply.unsignCookie(rawCookie)
      if (!unsigned.valid || !unsigned.value) return redirectOk('error')
      reply.clearCookie('oauth_state', { path: '/' })

      let statePayload: { protocol: string; userId: string; nonce: string }
      try {
        statePayload = JSON.parse(unsigned.value)
      } catch {
        return redirectOk('error')
      }
      if (statePayload.protocol !== 'atproto') return redirectOk('error')
      if (req.query.state !== statePayload.nonce) return redirectOk('error')

      try {
        const client = await getAtprotoClient()
        const params = new URLSearchParams(req.query as Record<string, string>)
        const { session } = await client.callback(params)
        const did = session.did

        // Pull handle/display name from the AppView for a nicer external_handle.
        let handle: string = did
        try {
          const profile = await getProfile(did)
          if (profile?.handle) handle = profile.handle
        } catch {
          // non-fatal
        }

        await pool.query(`
          INSERT INTO linked_accounts (
            account_id, protocol, external_id, external_handle,
            instance_url, credentials_enc, is_valid,
            last_refreshed_at, updated_at
          ) VALUES ($1, 'atproto', $2, $3, NULL, NULL, TRUE, now(), now())
          ON CONFLICT (account_id, protocol, external_id)
          DO UPDATE SET
            external_handle   = EXCLUDED.external_handle,
            is_valid          = TRUE,
            last_refreshed_at = now(),
            updated_at        = now()
        `, [statePayload.userId, did, handle])

        logger.info({ userId: statePayload.userId, did, handle }, 'Bluesky account linked')
        return redirectOk('bluesky')
      } catch (err) {
        logger.warn({ err }, 'Bluesky OAuth callback failed')
        return redirectOk('error')
      }
    }
  )
}

// =============================================================================
// Mastodon OAuth helpers
// =============================================================================

async function getOrRegisterMastodonApp(
  instance: string,
  redirectUri: string
): Promise<{ clientId: string; clientSecret: string }> {
  const { rows } = await pool.query<{ client_id: string; client_secret_enc: string }>(
    `SELECT client_id, client_secret_enc
     FROM oauth_app_registrations
     WHERE protocol = 'activitypub' AND instance_url = $1`,
    [instance]
  )
  if (rows[0]) {
    return {
      clientId: rows[0].client_id,
      clientSecret: decryptJson<string>(rows[0].client_secret_enc),
    }
  }

  const res = await safeFetch(`${instance}/api/v1/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: redirectUri,
      scopes: MASTODON_SCOPES,
      website: APP_URL,
    }),
  })
  if (!res.ok) throw new Error(`App registration HTTP ${res.status}`)

  const body = JSON.parse(res.text) as MastodonAppResponse
  if (!body.client_id || !body.client_secret) {
    throw new Error('App registration missing client_id/client_secret')
  }

  await pool.query(`
    INSERT INTO oauth_app_registrations (
      protocol, instance_url, client_id, client_secret_enc, scopes, redirect_uri
    ) VALUES ('activitypub', $1, $2, $3, $4, $5)
    ON CONFLICT (protocol, instance_url) DO NOTHING
  `, [instance, body.client_id, encryptJson(body.client_secret), MASTODON_SCOPES, redirectUri])

  return { clientId: body.client_id, clientSecret: body.client_secret }
}

async function getStoredMastodonApp(
  instance: string
): Promise<{ clientId: string; clientSecret: string }> {
  const { rows } = await pool.query<{ client_id: string; client_secret_enc: string }>(
    `SELECT client_id, client_secret_enc
     FROM oauth_app_registrations
     WHERE protocol = 'activitypub' AND instance_url = $1`,
    [instance]
  )
  if (!rows[0]) throw new Error('App registration not found')
  return {
    clientId: rows[0].client_id,
    clientSecret: decryptJson<string>(rows[0].client_secret_enc),
  }
}

async function exchangeMastodonCode(params: {
  instance: string
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<MastodonTokenResponse> {
  const res = await safeFetch(`${params.instance}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      scope: MASTODON_SCOPES,
    }),
  })
  if (!res.ok) throw new Error(`Token exchange HTTP ${res.status}`)
  return JSON.parse(res.text) as MastodonTokenResponse
}

async function fetchMastodonProfile(
  instance: string,
  accessToken: string
): Promise<MastodonVerifyCredentialsResponse> {
  const res = await safeFetch(`${instance}/api/v1/accounts/verify_credentials`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  })
  if (!res.ok) throw new Error(`verify_credentials HTTP ${res.status}`)
  return JSON.parse(res.text) as MastodonVerifyCredentialsResponse
}
