import { pool } from '../db/client.js'
import type { PaymentVerification } from '../types/index.js'

// =============================================================================
// Payment Verification
//
// Before issuing a content key, the key service verifies that the reader has
// a valid payment record for the article. This queries the shared PostgreSQL
// database — the key service and payment service share the same DB.
//
// Valid states for key issuance: accrued, platform_settled, writer_paid.
// (All three mean the reader has a real payment obligation or settlement.)
//
// Provisional reads are NOT valid for key issuance — the reader has no card
// connected and is on the free allowance. The free sample (pre-gate content)
// is available without payment; the paywalled body requires a real read event.
//
// Re-issuance: a reader who has previously paid can request the key again
// at any time (new device, session expiry, account recovery). The service
// checks for any non-provisional read event — not just the most recent one.
// =============================================================================

export async function verifyPayment(
  readerId: string,
  articleId: string
): Promise<PaymentVerification> {
  const { rows } = await pool.query<{
    id: string
    state: string
  }>(
    `SELECT id, state
     FROM read_events
     WHERE reader_id = $1
       AND article_id = $2
       AND state IN ('provisional', 'accrued', 'platform_settled', 'writer_paid')
     ORDER BY read_at DESC
     LIMIT 1`,
    [readerId, articleId]
  )

  if (rows.length === 0) {
    // Check if there's a provisional read (free allowance — not sufficient)
    const { rows: provisional } = await pool.query<{ id: string }>(
      `SELECT id FROM read_events
       WHERE reader_id = $1 AND article_id = $2 AND state = 'provisional'
       LIMIT 1`,
      [readerId, articleId]
    )

    return {
      isVerified: false,
      readEventId: provisional[0]?.id ?? null,
      state: null,
      readEventExists: provisional.length > 0,
    }
  }

  return {
    isVerified: true,
    readEventId: rows[0].id,
    state: rows[0].state as PaymentVerification['state'],
    readEventExists: true,
  }
}

// ---------------------------------------------------------------------------
// resolveArticleId — translates a Nostr event ID to the internal UUID
// The client sends the Nostr event ID; the key service works with UUIDs
// ---------------------------------------------------------------------------

export async function resolveArticleId(
  nostrEventId: string
): Promise<{ articleId: string; writerId: string } | null> {
  const { rows } = await pool.query<{ id: string; writer_id: string }>(
    `SELECT id, writer_id FROM articles WHERE nostr_event_id = $1`,
    [nostrEventId]
  )

  if (rows.length === 0) return null
  return { articleId: rows[0].id, writerId: rows[0].writer_id }
}
