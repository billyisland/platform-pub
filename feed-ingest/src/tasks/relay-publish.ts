import type { Task } from 'graphile-worker'
import type { PoolClient } from 'pg'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { publishNostrToRelays, type NostrSignedEvent } from '../adapters/nostr-outbound.js'

// =============================================================================
// relay_publish — publish a queued signed Nostr event to one or more relays.
//
// Payload: { outboxId: UUID }
//
// Claim + serialisation: SELECT FOR UPDATE SKIP LOCKED claims the row, and a
// transaction-scoped advisory lock keyed on (entity_type, entity_id)
// serialises concurrent workers operating on the same entity (e.g.
// subscription cancel → reactivate race). The publish and status UPDATE all
// run inside the same transaction so the row lock + advisory lock persist
// for the duration of the relay round-trip.
//
// Retry semantics live on relay_outbox (attempts / next_attempt_at /
// max_attempts). The graphile-worker job is scheduled with max_attempts := 1
// so Graphile's own retry loop doesn't race ours. On failure we schedule a
// fresh job with a versioned job_key.
//
// Partial success (some relays accept, some reject) is treated as sent per
// the §71 one-accepts rule; publishNostrToRelays logs per-relay rejections.
// =============================================================================

interface RelayOutboxRow {
  id: string
  entity_type: string
  entity_id: string | null
  signed_event: NostrSignedEvent
  target_relay_urls: string[]
  status: string
  attempts: number
  max_attempts: number
}

export const relayPublish: Task = async (payload, helpers) => {
  const { outboxId } = payload as { outboxId: string }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query<RelayOutboxRow>(
      `SELECT id, entity_type, entity_id, signed_event, target_relay_urls,
              status, attempts, max_attempts
         FROM relay_outbox
         WHERE id = $1
         FOR UPDATE SKIP LOCKED`,
      [outboxId],
    )
    if (rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }
    const row = rows[0]
    if (row.status !== 'pending' && row.status !== 'failed') {
      await client.query('ROLLBACK')
      return
    }

    if (row.entity_id) {
      const lockKey = `${row.entity_type}:${row.entity_id}`
      const { rows: lockRows } = await client.query<{ got: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got`,
        [lockKey],
      )
      if (!lockRows[0]?.got) {
        await client.query('ROLLBACK')
        logger.debug({ outboxId, lockKey }, 'relay_publish: entity locked by peer — redrive will retry')
        return
      }
    }

    const relayUrls = row.target_relay_urls.length > 0
      ? row.target_relay_urls
      : defaultRelayUrls()

    if (relayUrls.length === 0) {
      await failAndMaybeRetry(
        client, row,
        'No target relay URLs and PLATFORM_RELAY_WS_URL not set',
        helpers,
      )
      return
    }

    try {
      await publishNostrToRelays(row.signed_event, relayUrls)
      await client.query(
        `UPDATE relay_outbox
           SET status = 'sent',
               sent_at = now(),
               last_attempt_at = now(),
               attempts = attempts + 1,
               last_error = NULL
           WHERE id = $1`,
        [row.id],
      )
      await client.query('COMMIT')
      logger.info(
        { outboxId: row.id, entityType: row.entity_type, eventId: row.signed_event.id },
        'relay_publish: sent',
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await failAndMaybeRetry(client, row, msg, helpers)
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function failAndMaybeRetry(
  client: PoolClient,
  row: RelayOutboxRow,
  msg: string,
  helpers: Parameters<Task>[1],
): Promise<void> {
  const newAttempts = row.attempts + 1

  if (newAttempts >= row.max_attempts) {
    await client.query(
      `UPDATE relay_outbox
         SET status = 'abandoned',
             attempts = $2,
             last_attempt_at = now(),
             last_error = $3
         WHERE id = $1`,
      [row.id, newAttempts, msg],
    )
    await client.query('COMMIT')
    logger.warn(
      { outboxId: row.id, entityType: row.entity_type, attempts: newAttempts, err: msg },
      'relay_publish: abandoned after max_attempts',
    )
    return
  }

  const nextAt = computeBackoff(newAttempts)
  await client.query(
    `UPDATE relay_outbox
       SET status = 'failed',
           attempts = $2,
           last_attempt_at = now(),
           next_attempt_at = $3,
           last_error = $4
       WHERE id = $1`,
    [row.id, newAttempts, nextAt, msg],
  )
  await client.query('COMMIT')

  // Schedule the retry job outside the claim txn — the row lock has been
  // released by COMMIT and helpers.addJob uses its own connection.
  await helpers.addJob('relay_publish', { outboxId: row.id }, {
    runAt: nextAt,
    jobKey: `relay_publish_${row.id}_r${newAttempts}`,
    maxAttempts: 1,
  })
  logger.info(
    { outboxId: row.id, attempts: newAttempts, nextAt, err: msg },
    'relay_publish: retrying',
  )
}

function defaultRelayUrls(): string[] {
  const url = process.env.PLATFORM_RELAY_WS_URL
  return url ? [url] : []
}

function computeBackoff(attempts: number): Date {
  // min(2^attempts minutes, 1 hour) with ±10% jitter.
  const baseMs = Math.min(Math.pow(2, attempts) * 60_000, 3_600_000)
  const jitter = baseMs * (Math.random() * 0.2 - 0.1)
  return new Date(Date.now() + baseMs + jitter)
}
