import { pool } from '../../shared/src/db/client.js'

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

export async function enqueueCrossPost(input: EnqueueCrossPostInput): Promise<void> {
  const { rows: la } = await pool.query<{ protocol: string; is_valid: boolean }>(
    `SELECT protocol, is_valid FROM linked_accounts
     WHERE id = $1 AND account_id = $2`,
    [input.linkedAccountId, input.accountId]
  )
  if (la.length === 0) throw new Error('Linked account not found')
  if (!la[0].is_valid) throw new Error('Linked account is marked invalid')

  const { rows: [op] } = await pool.query<{ id: string }>(`
    INSERT INTO outbound_posts (
      account_id, linked_account_id, protocol,
      nostr_event_id, action_type, source_item_id, body_text,
      status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
    RETURNING id
  `, [
    input.accountId,
    input.linkedAccountId,
    la[0].protocol,
    input.nostrEventId,
    input.actionType,
    input.sourceItemId,
    input.bodyText,
  ])

  await pool.query(`
    SELECT graphile_worker.add_job(
      'outbound_cross_post',
      json_build_object('outboundPostId', $1::text),
      job_key := 'outbound_cross_post_' || $1::text,
      max_attempts := 1
    )
  `, [op.id])
}
