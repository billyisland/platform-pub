import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify'
import { verifySession, refreshIfNeeded, type SessionPayload } from '../../shared/src/auth/session.js'
import { pool } from '../../shared/src/db/client.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Auth Middleware
//
// Sits in the gateway. Two variants:
//
//   requireAuth — request fails with 401 if no valid session.
//                 Injects x-reader-id, x-reader-pubkey, x-writer-id headers
//                 that downstream services (payment, key) expect.
//
//   optionalAuth — decorates request with session info if present,
//                  but allows unauthenticated requests through.
//                  Used for public pages (article reading, feed).
//
// The gateway is the ONLY service that touches cookies or JWTs.
// Downstream services trust the injected headers unconditionally.
// =============================================================================

// Extend FastifyRequest with session data
declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionPayload | null
  }
}

// ---------------------------------------------------------------------------
// requireAuth — 401 if not authenticated
// ---------------------------------------------------------------------------

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const session = await verifySession(req)

  if (!session || !session.sub) {
    reply.status(401).send({ error: 'Authentication required' })
    return
  }

  // Check account status — suspended users must not retain API access
  const accountRow = await pool.query<{ status: string }>(
    'SELECT status FROM accounts WHERE id = $1',
    [session.sub]
  )
  if (accountRow.rowCount === 0 || accountRow.rows[0].status !== 'active') {
    reply.status(403).send({ error: 'Account suspended or not found' })
    return
  }

  // Inject headers for downstream services
  req.headers['x-reader-id'] = session.sub
  req.headers['x-reader-pubkey'] = session.pubkey

  req.headers['x-writer-id'] = session.sub

  // Attach to request for route handlers
  req.session = session

  // Silently refresh session if past half-life
  await refreshIfNeeded(req, reply, session)
}

// ---------------------------------------------------------------------------
// optionalAuth — attaches session if present, allows anonymous
// ---------------------------------------------------------------------------

export async function optionalAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const session = await verifySession(req)

  if (session?.sub) {
    req.headers['x-reader-id'] = session.sub
    req.headers['x-reader-pubkey'] = session.pubkey

    req.headers['x-writer-id'] = session.sub

    req.session = session
    await refreshIfNeeded(req, reply, session)
  } else {
    req.session = null
  }
}
