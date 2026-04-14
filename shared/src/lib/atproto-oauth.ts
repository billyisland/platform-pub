import { NodeOAuthClient, type NodeSavedSession, type NodeSavedSessionStore, type NodeSavedState, type NodeSavedStateStore } from '@atproto/oauth-client-node'
import { JoseKey } from '@atproto/jwk-jose'
import { pool } from '../db/client.js'
import { encryptJson, decryptJson } from './crypto.js'
import logger from './logger.js'

// =============================================================================
// AT Protocol OAuth client (confidential, private_key_jwt)
//
// Shared singleton used by:
//   - gateway: authorize() + callback() for linking a Bluesky account
//   - feed-ingest: restore() for outbound posts and token-refresh cron
//
// Session bookkeeping (NodeSavedSession: TokenSet + DPoP key per DID) lives in
// `atproto_oauth_sessions`, AES-256-GCM encrypted with LINKED_ACCOUNT_KEY_HEX.
// State bookkeeping (PKCE verifier + DPoP key between authorize/callback) lives
// in-memory — only the gateway runs that half of the dance and the flow is
// short-lived (~10 minutes).
//
// Dev mode (ATPROTO_CLIENT_BASE_URL unset or localhost): use the loopback
// client_id encoding (`http://localhost?...`) so no JWKS endpoint is required.
// Prod: clientId = ${BASE}/.well-known/oauth-client-metadata.json, backed by a
// signing JWK loaded from ATPROTO_PRIVATE_JWK.
// =============================================================================

const SCOPE = 'atproto transition:generic'
const CALLBACK_PATH = '/api/v1/linked-accounts/bluesky/callback'

class DbSessionStore implements NodeSavedSessionStore {
  async get(did: string): Promise<NodeSavedSession | undefined> {
    const { rows } = await pool.query<{ session_data_enc: string }>(
      'SELECT session_data_enc FROM atproto_oauth_sessions WHERE did = $1',
      [did]
    )
    if (rows.length === 0) return undefined
    try {
      return decryptJson<NodeSavedSession>(rows[0].session_data_enc)
    } catch (err) {
      logger.error({ err, did }, 'Failed to decrypt atproto OAuth session')
      return undefined
    }
  }
  async set(did: string, session: NodeSavedSession): Promise<void> {
    const enc = encryptJson(session)
    await pool.query(
      `INSERT INTO atproto_oauth_sessions (did, session_data_enc, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (did) DO UPDATE SET session_data_enc = EXCLUDED.session_data_enc, updated_at = now()`,
      [did, enc]
    )
  }
  async del(did: string): Promise<void> {
    await pool.query('DELETE FROM atproto_oauth_sessions WHERE did = $1', [did])
  }
}

class MemoryStateStore implements NodeSavedStateStore {
  private map = new Map<string, { value: NodeSavedState; expiresAt: number }>()
  private ttlMs = 10 * 60 * 1000
  async get(key: string): Promise<NodeSavedState | undefined> {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key)
      return undefined
    }
    return entry.value
  }
  async set(key: string, value: NodeSavedState): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    if (this.map.size > 100) {
      const now = Date.now()
      for (const [k, v] of this.map) if (v.expiresAt < now) this.map.delete(k)
    }
  }
  async del(key: string): Promise<void> {
    this.map.delete(key)
  }
}

let clientPromise: Promise<NodeOAuthClient> | null = null

export function getAtprotoClient(): Promise<NodeOAuthClient> {
  if (!clientPromise) clientPromise = buildClient()
  return clientPromise
}

async function buildClient(): Promise<NodeOAuthClient> {
  const baseUrl = process.env.ATPROTO_CLIENT_BASE_URL?.trim() || ''
  const privateJwkRaw = process.env.ATPROTO_PRIVATE_JWK?.trim() || ''

  const sessionStore = new DbSessionStore()
  const stateStore = new MemoryStateStore()

  const useLoopback = !baseUrl || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(baseUrl)

  if (useLoopback) {
    // Loopback client: clientId is constructed from scope + redirect_uri query
    // params; no JWKS required. Use for local dev only.
    const redirectUri = `http://127.0.0.1:3000${CALLBACK_PATH}`
    const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`
    return new NodeOAuthClient({
      clientMetadata: {
        client_id: clientId,
        redirect_uris: [redirectUri],
        scope: SCOPE,
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        application_type: 'web',
        token_endpoint_auth_method: 'none',
        dpop_bound_access_tokens: true,
      },
      stateStore,
      sessionStore,
      allowHttp: true,
    })
  }

  if (!privateJwkRaw) {
    throw new Error('ATPROTO_PRIVATE_JWK must be set when ATPROTO_CLIENT_BASE_URL is a public origin')
  }
  const key = await JoseKey.fromJWK(privateJwkRaw, 'atproto-signing-key')

  const redirectUri = `${baseUrl}${CALLBACK_PATH}` as `https://${string}`
  const clientId = `${baseUrl}/.well-known/oauth-client-metadata.json` as `https://${string}`

  return new NodeOAuthClient({
    clientMetadata: {
      client_id: clientId,
      client_name: 'all.haus',
      client_uri: baseUrl as `https://${string}`,
      redirect_uris: [redirectUri],
      scope: SCOPE,
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      application_type: 'web',
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      dpop_bound_access_tokens: true,
      jwks_uri: `${baseUrl}/.well-known/jwks.json` as `https://${string}`,
    },
    keyset: [key],
    stateStore,
    sessionStore,
  })
}

export function atprotoClientMetadata(): Promise<unknown> {
  return getAtprotoClient().then((c) => c.clientMetadata)
}

export function atprotoJwks(): Promise<unknown> {
  return getAtprotoClient().then((c) => c.jwks)
}
