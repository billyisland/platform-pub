import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import type { FastifyRequest, FastifyReply } from 'fastify'
import '@fastify/cookie'

// =============================================================================
// Session Management
//
// JWT-based sessions stored in httpOnly secure cookies.
//
// Flow:
//   1. User signs up or logs in → createSession() → sets cookie
//   2. Every request → verifySession() middleware → extracts account info
//   3. Gateway injects x-reader-id, x-writer-id, x-reader-pubkey headers
//      for downstream services (payment, key service)
//
// The JWT contains:
//   - sub: account UUID
//   - pubkey: Nostr hex pubkey
//   - isWriter: boolean
//   - iat/exp: standard claims
//
// Token lifetime: 2 hours. Refresh-on-use extends the session silently
// when the token is past its half-life (1 hour). Active users stay
// logged in indefinitely; idle sessions expire after 2 hours.
// =============================================================================

const TOKEN_LIFETIME_SECONDS = 2 * 60 * 60          // 2 hours
const REFRESH_AFTER_SECONDS = 1 * 60 * 60           // refresh past half-life
const COOKIE_NAME = 'pp_session'

export interface SessionPayload extends JWTPayload {
  sub: string          // account UUID
  pubkey: string       // Nostr hex pubkey
  isWriter: boolean
}

// ---------------------------------------------------------------------------
// getSigningKey — loads from env, cached
// ---------------------------------------------------------------------------

let signingKey: Uint8Array | null = null

function getSigningKey(): Uint8Array {
  if (signingKey) return signingKey
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters')
  }
  signingKey = new TextEncoder().encode(secret)
  return signingKey
}

// ---------------------------------------------------------------------------
// createSession — called after signup or login
// ---------------------------------------------------------------------------

export async function createSession(
  reply: FastifyReply,
  account: { id: string; nostrPubkey: string; isWriter: boolean }
): Promise<string> {
  const key = getSigningKey()

  const token = await new SignJWT({
    pubkey: account.nostrPubkey,
    isWriter: account.isWriter,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(account.id)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_LIFETIME_SECONDS}s`)
    .sign(key)

  setCookie(reply, token)
  return token
}

// ---------------------------------------------------------------------------
// verifySession — extracts and validates session from cookie
// Returns null if no session or invalid (not an error — unauthenticated is OK)
// ---------------------------------------------------------------------------

export async function verifySession(
  req: FastifyRequest
): Promise<SessionPayload | null> {
  const token = getCookie(req)
  if (!token) return null

  try {
    const key = getSigningKey()
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
    })

    return payload as SessionPayload
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// refreshIfNeeded — silently extends session past half-life
// Call this in the gateway after successful verification.
// ---------------------------------------------------------------------------

export async function refreshIfNeeded(
  req: FastifyRequest,
  reply: FastifyReply,
  session: SessionPayload
): Promise<void> {
  if (!session.iat) return

  const age = Math.floor(Date.now() / 1000) - session.iat
  if (age < REFRESH_AFTER_SECONDS) return

  // Past half-life — issue a fresh token
  await createSession(reply, {
    id: session.sub!,
    nostrPubkey: session.pubkey,
    isWriter: session.isWriter,
  })
}

// ---------------------------------------------------------------------------
// destroySession — clears the cookie
// ---------------------------------------------------------------------------

export function destroySession(reply: FastifyReply): void {
  reply.setCookie(COOKIE_NAME, '', {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
  })
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function setCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: TOKEN_LIFETIME_SECONDS,
  })
}

function getCookie(req: FastifyRequest): string | null {
  const cookies = req.cookies as Record<string, string> | undefined
  return cookies?.[COOKIE_NAME] ?? null
}
