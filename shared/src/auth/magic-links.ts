import { randomBytes, createHash } from 'crypto'
import { pool } from '../db/client.js'
import logger from '../lib/logger.js'

// =============================================================================
// Magic Link Service
//
// Passwordless email login flow:
//   1. User enters email → requestMagicLink() generates a token, stores hash,
//      and returns the raw token for emailing.
//   2. User clicks the link → verifyMagicLink() checks the token hash,
//      marks it as used, and returns the account ID.
//   3. The auth route creates a session for the account.
//
// Security:
//   - Token is 32 random bytes, URL-safe base64 encoded
//   - Only the SHA-256 hash is stored in the DB — raw token never persisted
//   - Single-use: marked as used_at on verification
//   - 15-minute expiry
//   - Rate limiting is handled at the gateway (Fastify rate-limit plugin)
// =============================================================================

const TOKEN_EXPIRY_MINUTES = 15

// ---------------------------------------------------------------------------
// requestMagicLink — generates a token for an email address
// Returns the raw token (to embed in the email link) or null if no account
// ---------------------------------------------------------------------------

export interface MagicLinkResult {
  token: string           // raw token — put this in the email link
  accountId: string
  expiresAt: Date
}

export async function requestMagicLink(email: string): Promise<MagicLinkResult | null> {
  // Look up account by email
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE email = $1 AND status = $2',
    [email.toLowerCase().trim(), 'active']
  )

  if (rows.length === 0) {
    // Don't reveal whether the email exists — return null silently
    // The route should return a generic "if an account exists..." message
    logger.debug({ email: email.slice(0, 3) + '***' }, 'Magic link requested for unknown email')
    return null
  }

  const accountId = rows[0].id

  // Generate token
  const tokenBytes = randomBytes(32)
  const token = tokenBytes.toString('base64url')  // URL-safe, no padding
  const tokenHash = hashToken(token)

  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000)

  // Store the hash (never the raw token)
  await pool.query(
    `INSERT INTO magic_links (account_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [accountId, tokenHash, expiresAt]
  )

  logger.info({ accountId }, 'Magic link generated')

  return { token, accountId, expiresAt }
}

// ---------------------------------------------------------------------------
// verifyMagicLink — validates and consumes a token
// Returns the account ID if valid, null otherwise
// ---------------------------------------------------------------------------

export async function verifyMagicLink(token: string): Promise<string | null> {
  const tokenHash = hashToken(token)

  // Find unused, non-expired magic link
  const { rows } = await pool.query<{ id: string; account_id: string }>(
    `SELECT id, account_id FROM magic_links
     WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > now()
     LIMIT 1`,
    [tokenHash]
  )

  if (rows.length === 0) {
    logger.debug('Magic link verification failed — token not found, used, or expired')
    return null
  }

  const magicLink = rows[0]

  // Mark as used (single-use)
  await pool.query(
    'UPDATE magic_links SET used_at = now() WHERE id = $1',
    [magicLink.id]
  )

  logger.info({ accountId: magicLink.account_id }, 'Magic link verified')

  return magicLink.account_id
}

// ---------------------------------------------------------------------------
// cleanupExpiredLinks — housekeeping, run periodically
// ---------------------------------------------------------------------------

export async function cleanupExpiredLinks(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM magic_links
     WHERE expires_at < now() - INTERVAL '1 hour'`
  )

  if (rowCount && rowCount > 0) {
    logger.debug({ deleted: rowCount }, 'Cleaned up expired magic links')
  }

  return rowCount ?? 0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
