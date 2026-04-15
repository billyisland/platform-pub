import { pool, withTransaction } from '../../shared/src/db/client.js'

// =============================================================================
// Outbound cross-post enqueue helper
//
// Creates the outbound_posts audit row and schedules the Graphile Worker job
// in a single transaction. The worker (feed-ingest/src/tasks/outbound-cross-post)
// picks it up, decrypts credentials, and dispatches to the right adapter.
//
// Validates that the linked_account belongs to the requesting user and is still
// valid — callers should still treat failures as non-fatal (the native note is
// already indexed, cross-posting is best-effort).
// =============================================================================

export interface EnqueueCrossPostInput {
  accountId: string            // all.haus user id
  linkedAccountId: string      // linked_accounts.id
  sourceItemId: string         // external_items.id being replied/quoted
  actionType: 'reply' | 'quote'
  nostrEventId: string
  bodyText: string
}

export interface SignedNostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface EnqueueNostrOutboundInput {
  accountId: string
  sourceItemId: string         // external_items.id (carries the source's relay_urls)
  nostrEventId: string
  bodyText: string
  signedEvent: SignedNostrEvent
  actionType: 'reply' | 'quote'
}

export async function enqueueCrossPost(input: EnqueueCrossPostInput): Promise<void> {
  const { rows: la } = await pool.query<{ protocol: string; is_valid: boolean }>(
    `SELECT protocol, is_valid FROM linked_accounts
     WHERE id = $1 AND account_id = $2`,
    [input.linkedAccountId, input.accountId]
  )
  if (la.length === 0) throw new Error('Linked account not found')
  if (!la[0].is_valid) throw new Error('Linked account is marked invalid')

  // Wrap the audit INSERT + add_job in a single transaction so a crash between
  // them can't leave a 'pending' outbound_posts row with no matching worker job.
  // ON CONFLICT handles the dedup index from migration 062: a second enqueue
  // for the same (account, nostr_event, target, action_type) returns the
  // existing row instead of raising, and we skip re-enqueueing the job.
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; existed: boolean }>(`
      WITH ins AS (
        INSERT INTO outbound_posts (
          account_id, linked_account_id, protocol,
          nostr_event_id, action_type, source_item_id, body_text,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      SELECT id, FALSE AS existed FROM ins
      UNION ALL
      SELECT id, TRUE FROM outbound_posts
       WHERE account_id = $1 AND linked_account_id IS NOT DISTINCT FROM $2
         AND nostr_event_id = $4 AND action_type = $5
      LIMIT 1
    `, [
      input.accountId,
      input.linkedAccountId,
      la[0].protocol,
      input.nostrEventId,
      input.actionType,
      input.sourceItemId,
      input.bodyText,
    ])

    const op = rows[0]
    if (!op || op.existed) return
    await client.query(`
      SELECT graphile_worker.add_job(
        'outbound_cross_post',
        json_build_object('outboundPostId', $1::text),
        job_key := 'outbound_cross_post_' || $1::text,
        max_attempts := 1
      )
    `, [op.id])
  })
}

// =============================================================================
// Nostr-external variant — no linked_accounts row, signed event ships with the
// audit row so the worker can replay it onto the source's relays.
// =============================================================================

export async function enqueueNostrOutbound(input: EnqueueNostrOutboundInput): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; existed: boolean }>(`
      WITH ins AS (
        INSERT INTO outbound_posts (
          account_id, linked_account_id, protocol,
          nostr_event_id, action_type, source_item_id, body_text,
          signed_event, status
        ) VALUES ($1, NULL, 'nostr_external', $2, $3, $4, $5, $6::jsonb, 'pending')
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      SELECT id, FALSE AS existed FROM ins
      UNION ALL
      SELECT id, TRUE FROM outbound_posts
       WHERE account_id = $1 AND linked_account_id IS NULL
         AND nostr_event_id = $2 AND action_type = $3
      LIMIT 1
    `, [
      input.accountId,
      input.nostrEventId,
      input.actionType,
      input.sourceItemId,
      input.bodyText,
      JSON.stringify(input.signedEvent),
    ])

    const op = rows[0]
    if (!op || op.existed) return
    await client.query(`
      SELECT graphile_worker.add_job(
        'outbound_cross_post',
        json_build_object('outboundPostId', $1::text),
        job_key := 'outbound_cross_post_' || $1::text,
        max_attempts := 1
      )
    `, [op.id])
  })
}
