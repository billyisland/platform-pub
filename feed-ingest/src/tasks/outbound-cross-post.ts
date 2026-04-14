import type { Task } from 'graphile-worker'
import { pool } from '../../shared/src/db/client.js'
import { decryptJson } from '../../shared/src/lib/crypto.js'
import logger from '../../shared/src/lib/logger.js'
import { postMastodonStatus, type MastodonCredentials } from '../adapters/activitypub-outbound.js'
import { publishNostrToRelays, type NostrSignedEvent } from '../adapters/nostr-outbound.js'

// =============================================================================
// outbound_cross_post — per-event job, dispatches a queued outbound_posts row
// to the appropriate external platform.
//
// Payload: { outboundPostId: UUID }
//
// Responsibilities:
//   - Load outbound_posts row + linked_accounts + source external_items (if any)
//   - Decrypt credentials, call the protocol-specific adapter
//   - On success: set status='sent', external_post_uri, sent_at
//   - On failure: increment retry_count; if below max_retries, mark 'retrying'
//     and re-enqueue after outbound_retry_delay_seconds * 2^retry_count.
//     Otherwise mark 'failed' and stop.
//
// The native all.haus event is never touched — outbound failure only affects
// outbound_posts.
// =============================================================================

interface OutboundRow {
  id: string
  account_id: string
  linked_account_id: string | null
  protocol: string
  nostr_event_id: string
  action_type: string
  source_item_id: string | null
  body_text: string | null
  signed_event: NostrSignedEvent | null
  status: string
  retry_count: number
  max_retries: number
  // Linked account fields (NULL for nostr_external)
  la_external_id: string | null
  la_instance_url: string | null
  la_credentials_enc: string | null
  la_is_valid: boolean | null
  // Source item fields (nullable — NULL for top-level posts)
  ei_source_item_uri: string | null
  // Source relay URLs (nostr_external only)
  ei_source_relay_urls: string[] | null
}

interface AllHausMeta {
  bluesky_max: number
  mastodon_max: number
  max_retries: number
  retry_delay: number
}

export const outboundCrossPost: Task = async (payload, helpers) => {
  const { outboundPostId } = payload as { outboundPostId: string }

  const { rows } = await pool.query<OutboundRow>(`
    SELECT
      op.id, op.account_id, op.linked_account_id, op.protocol,
      op.nostr_event_id, op.action_type, op.source_item_id, op.body_text,
      op.signed_event, op.status, op.retry_count, op.max_retries,
      la.external_id       AS la_external_id,
      la.instance_url      AS la_instance_url,
      la.credentials_enc   AS la_credentials_enc,
      la.is_valid          AS la_is_valid,
      ei.source_item_uri   AS ei_source_item_uri,
      xs.relay_urls        AS ei_source_relay_urls
    FROM outbound_posts op
    LEFT JOIN linked_accounts la ON la.id = op.linked_account_id
    LEFT JOIN external_items ei  ON ei.id = op.source_item_id
    LEFT JOIN external_sources xs ON xs.id = ei.source_id
    WHERE op.id = $1
  `, [outboundPostId])
  const row = rows[0]
  if (!row) {
    logger.warn({ outboundPostId }, 'outbound_cross_post: row not found')
    return
  }
  if (row.status === 'sent') return
  if (row.status === 'failed') return
  // Linked account is required for OAuth-backed protocols only.
  if (row.protocol !== 'nostr_external' && !row.la_is_valid) {
    await markFailed(row.id, 'Linked account invalid — reconnect in settings')
    return
  }

  const cfg = await loadConfig()

  try {
    let externalPostUri: string

    if (row.protocol === 'activitypub') {
      if (!row.la_instance_url) throw new Error('Linked account has no instance_url')
      if (!row.la_credentials_enc) throw new Error('Linked account has no credentials')
      const creds = decryptJson<MastodonCredentials>(row.la_credentials_enc)
      const result = await postMastodonStatus({
        instanceUrl: row.la_instance_url,
        text: row.body_text ?? '',
        maxChars: cfg.mastodon_max,
        replyToStatusUri: row.action_type === 'reply' ? (row.ei_source_item_uri ?? undefined) : undefined,
      }, creds)
      externalPostUri = result.externalPostUri
    } else if (row.protocol === 'nostr_external') {
      if (!row.signed_event) throw new Error('outbound_posts.signed_event missing for nostr_external job')
      const relays = row.ei_source_relay_urls ?? []
      if (relays.length === 0) throw new Error('Source has no relay URLs configured')
      externalPostUri = await publishNostrToRelays(row.signed_event, relays)
    } else {
      throw new Error(`Outbound protocol not yet supported: ${row.protocol}`)
    }

    await pool.query(`
      UPDATE outbound_posts
      SET status = 'sent',
          external_post_uri = $2,
          sent_at = now(),
          error_message = NULL
      WHERE id = $1
    `, [row.id, externalPostUri])

    logger.info({ outboundPostId: row.id, protocol: row.protocol, externalPostUri }, 'outbound cross-post sent')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const newRetry = row.retry_count + 1
    if (newRetry >= row.max_retries) {
      await markFailed(row.id, msg)
      logger.warn({ outboundPostId: row.id, err: msg }, 'outbound cross-post failed permanently')
      return
    }

    await pool.query(`
      UPDATE outbound_posts
      SET status = 'retrying', retry_count = $2, error_message = $3
      WHERE id = $1
    `, [row.id, newRetry, msg])

    const delay = cfg.retry_delay * Math.pow(2, newRetry - 1)
    await helpers.addJob('outbound_cross_post', { outboundPostId: row.id }, {
      runAt: new Date(Date.now() + delay * 1000),
      jobKey: `outbound_cross_post_${row.id}`,
      maxAttempts: 1,
    })
    logger.info({ outboundPostId: row.id, retry: newRetry, delay, err: msg }, 'outbound cross-post retrying')
  }
}

async function markFailed(id: string, msg: string): Promise<void> {
  await pool.query(`
    UPDATE outbound_posts
    SET status = 'failed', error_message = $2
    WHERE id = $1
  `, [id, msg])
}

async function loadConfig(): Promise<AllHausMeta> {
  const { rows } = await pool.query<{ key: string; value: string }>(`
    SELECT key, value FROM platform_config
    WHERE key IN (
      'outbound_bluesky_max_graphemes',
      'outbound_mastodon_max_chars',
      'outbound_max_retries',
      'outbound_retry_delay_seconds'
    )
  `)
  const m = new Map(rows.map(r => [r.key, r.value]))
  return {
    bluesky_max: parseInt(m.get('outbound_bluesky_max_graphemes') ?? '300', 10),
    mastodon_max: parseInt(m.get('outbound_mastodon_max_chars') ?? '500', 10),
    max_retries: parseInt(m.get('outbound_max_retries') ?? '3', 10),
    retry_delay: parseInt(m.get('outbound_retry_delay_seconds') ?? '30', 10),
  }
}
