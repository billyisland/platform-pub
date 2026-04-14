import type { Task } from 'graphile-worker'
import { pool } from '../../shared/src/db/client.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// outbound_token_refresh — daemon-style cron job
//
// Walks linked_accounts and refreshes any OAuth credentials that are inside
// the configured refresh window. Mastodon tokens issued by the standard
// /oauth/token endpoint do not expire (the Mastodon docs are explicit) and
// have no refresh_token, so they are skipped here. The job becomes load-
// bearing when the Bluesky AT Protocol adapter ships, since AT Protocol
// access tokens are short-lived and DPoP-bound.
//
// On refresh failure the linked account is marked is_valid=FALSE; the user
// sees a "reconnect" prompt the next time settings is opened, and any
// queued outbound_posts for that account will short-circuit to 'failed'.
// =============================================================================

interface DueRow {
  id: string
  protocol: string
  external_handle: string | null
  token_expires_at: Date
}

export const outboundTokenRefresh: Task = async () => {
  const windowPct = await loadRefreshWindowPct()

  // Pick accounts whose token has burned through `windowPct`% of its
  // total lifetime (last_refreshed_at → token_expires_at). Accounts with no
  // expires_at are non-expiring (Mastodon) and are skipped.
  const { rows } = await pool.query<DueRow>(`
    SELECT id, protocol, external_handle, token_expires_at
    FROM linked_accounts
    WHERE is_valid = TRUE
      AND credentials_enc IS NOT NULL
      AND token_expires_at IS NOT NULL
      AND last_refreshed_at IS NOT NULL
      AND EXTRACT(EPOCH FROM (now() - last_refreshed_at))
          >= ($1::numeric / 100.0)
           * EXTRACT(EPOCH FROM (token_expires_at - last_refreshed_at))
    ORDER BY token_expires_at ASC
    LIMIT 100
  `, [windowPct])

  if (rows.length === 0) return

  for (const row of rows) {
    try {
      switch (row.protocol) {
        case 'atproto':
          // Bluesky refresh ships alongside the AT Protocol outbound adapter.
          // Until then, leave the row alone — token is still inside its
          // declared lifetime; the cron will retry on the next tick.
          logger.debug({ id: row.id }, 'atproto refresh handler not yet implemented; skipping')
          break

        default:
          // Mastodon / nostr_external / rss have no refresh contract at this
          // layer (Mastodon tokens don't expire; nostr/rss have no OAuth).
          logger.debug({ id: row.id, protocol: row.protocol }, 'no refresh handler for protocol; skipping')
          break
      }
    } catch (err) {
      logger.warn(
        { err, id: row.id, protocol: row.protocol },
        'token refresh failed; marking account invalid'
      )
      await pool.query(
        `UPDATE linked_accounts SET is_valid = FALSE, updated_at = now() WHERE id = $1`,
        [row.id]
      )
    }
  }
}

async function loadRefreshWindowPct(): Promise<number> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = 'outbound_token_refresh_window_pct'`
  )
  return parseInt(rows[0]?.value ?? '80', 10)
}
