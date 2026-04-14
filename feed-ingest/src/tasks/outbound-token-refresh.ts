import type { Task } from 'graphile-worker'
import { pool } from '../../shared/src/db/client.js'
import { getAtprotoClient } from '../../shared/src/lib/atproto-oauth.js'
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

  for (const row of rows) {
    // credentials_enc-based OAuth refresh isn't wired up yet — Mastodon tokens
    // don't expire, so nothing currently lands here. Future protocols with
    // refresh_token semantics can branch on row.protocol below.
    logger.debug({ id: row.id, protocol: row.protocol }, 'no credentials_enc refresh handler; skipping')
  }

  // ---------------------------------------------------------------------------
  // AT Protocol: tokens live in atproto_oauth_sessions (credentials_enc IS NULL
  // in linked_accounts). The @atproto/oauth-client-node lib auto-refreshes on
  // use, but dormant accounts risk letting the refresh token expire. We
  // proactively touch each atproto session once a week by calling restore()
  // with refresh='auto' — the lib decides whether to refresh based on its
  // own TTL heuristics.
  // ---------------------------------------------------------------------------

  const { rows: atpRows } = await pool.query<{ id: string; external_id: string }>(`
    SELECT id, external_id
    FROM linked_accounts
    WHERE protocol = 'atproto'
      AND is_valid = TRUE
      AND (last_refreshed_at IS NULL OR last_refreshed_at < now() - INTERVAL '7 days')
    ORDER BY last_refreshed_at ASC NULLS FIRST
    LIMIT 50
  `)

  if (atpRows.length === 0) return

  const client = await getAtprotoClient()
  for (const row of atpRows) {
    try {
      await client.restore(row.external_id, 'auto')
      await pool.query(
        `UPDATE linked_accounts SET last_refreshed_at = now(), updated_at = now() WHERE id = $1`,
        [row.id]
      )
      logger.debug({ did: row.external_id }, 'atproto session touched')
    } catch (err) {
      logger.warn({ err, id: row.id, did: row.external_id }, 'atproto session restore failed; marking invalid')
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
