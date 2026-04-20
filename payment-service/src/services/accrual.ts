import type { PoolClient } from 'pg'
import type { GatePassEvent, ReadEvent, ReadingTab, PlatformConfig } from '../types/index.js'
import { pool, withTransaction, loadConfig } from '../../shared/src/db/client.js'
import { publishReceiptEvent, createPortableReceipt } from '../lib/nostr.js'
import logger from '../lib/logger.js'

// =============================================================================
// Read classification — extracted as a pure function for testability
// =============================================================================

export interface ReadClassification {
  readState: 'provisional' | 'accrued'
  onFreeAllowance: boolean
  allowanceJustExhausted: boolean
}

export function classifyRead(
  hasCard: boolean,
  freeAllowanceRemainingPence: number,
  amountPence: number,
): ReadClassification {
  const allowanceJustExhausted = !hasCard &&
    freeAllowanceRemainingPence > 0 &&
    freeAllowanceRemainingPence - amountPence <= 0

  return {
    readState: hasCard ? 'accrued' : 'provisional',
    onFreeAllowance: !hasCard && freeAllowanceRemainingPence > 0,
    allowanceJustExhausted,
  }
}

// =============================================================================
// AccrualService — Stage 1 of the three-stage money flow
//
// When a reader passes a paywall gate:
//   1. Determine read state (provisional vs accrued)
//   2. Write read_event record (DB-first, never fail the read for a Nostr issue)
//   3. Update the reader's reading_tab balance
//   4. Async: publish kind 9901 receipt to the relay
//   5. Return the read event — caller (gate route) uses this to issue content key
// =============================================================================

const CONFIG_TTL_MS = 5 * 60 * 1000 // 5 minutes

export class AccrualService {
  private config: PlatformConfig | null = null
  private configLoadedAt = 0

  async getConfig(): Promise<PlatformConfig> {
    if (!this.config || Date.now() - this.configLoadedAt > CONFIG_TTL_MS) {
      this.config = await loadConfig()
      this.configLoadedAt = Date.now()
    }
    return this.config
  }

  // Call this on config changes rather than restarting the service
  invalidateConfig() {
    this.config = null
    this.configLoadedAt = 0
  }

  // ---------------------------------------------------------------------------
  // recordGatePass — the main entry point
  // Called synchronously in the gate-pass request path; must be fast.
  // ---------------------------------------------------------------------------

  async recordGatePass(event: GatePassEvent): Promise<{ readEvent: ReadEvent; allowanceJustExhausted: boolean }> {
    const config = await this.getConfig()

    return withTransaction(async (client) => {
      // Determine read state based on whether the reader has a card connected
      const readerRow = await client.query<{
        stripe_customer_id: string | null
        free_allowance_remaining_pence: number
      }>(
        `SELECT stripe_customer_id, free_allowance_remaining_pence
         FROM accounts WHERE id = $1 FOR UPDATE`,
        [event.readerId]
      )

      if (readerRow.rowCount === 0) {
        throw new Error(`Reader not found: ${event.readerId}`)
      }

      const reader = readerRow.rows[0]
      const hasCard = reader.stripe_customer_id !== null

      const classification = classifyRead(
        hasCard,
        reader.free_allowance_remaining_pence,
        event.amountPence,
      )
      const { readState, onFreeAllowance, allowanceJustExhausted } = classification

      if (!hasCard) {
        // Provisional: reader has no card — debit against free allowance (can go negative)

        await client.query(
          `UPDATE accounts
           SET free_allowance_remaining_pence = free_allowance_remaining_pence - $1,
               updated_at = now()
           WHERE id = $2`,
          [event.amountPence, event.readerId]
        )
      }

      // Write the read_event record — DB-first per dual-write architecture (§II.4b)
      const readEventRow = await client.query<ReadEvent>(
        `INSERT INTO read_events (
           reader_id, article_id, writer_id, tab_id,
           amount_pence, state, reader_pubkey_hash, on_free_allowance
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          event.readerId,
          event.articleId,
          event.writerId,
          event.tabId,
          event.amountPence,
          readState,
          event.readerPubkeyHash,
          onFreeAllowance,
        ]
      )

      const readEvent = readEventRow.rows[0]

      // Update reading tab balance (only for accrued reads — tab is real money owed)
      // Lock the tab row first to prevent lost updates from concurrent gate passes
      if (readState === 'accrued') {
        await client.query(
          `SELECT id FROM reading_tabs WHERE id = $1 FOR UPDATE`,
          [event.tabId]
        )
        await client.query(
          `UPDATE reading_tabs
           SET balance_pence = balance_pence + $1,
               last_read_at  = now(),
               updated_at    = now()
           WHERE id = $2`,
          [event.amountPence, event.tabId]
        )
      }

      // FIX #10: Use a proper async helper that catches errors reliably,
      // instead of setImmediate with an async callback (which can silently
      // swallow rejections if the promise rejects outside the try/catch).
      publishReceiptAsync(readEvent, event).catch(() => {
        // Already logged inside publishReceiptAsync — no-op here
      })

      logger.info(
        { readEventId: readEvent.id, state: readState, amountPence: event.amountPence },
        'Gate pass recorded'
      )

      return { readEvent, allowanceJustExhausted }
    })
  }

  // ---------------------------------------------------------------------------
  // convertProvisionalReads — called when a reader connects their card
  //
  // FIX #5: The ADR says free-allowance reads that never convert are written
  // off, and partial conversions are absorbed by the platform. This method
  // now converts provisional reads to accrued but tracks the free-allowance
  // origin so that the settlement process can apply the correct write-off
  // treatment per ADR §I.3 / §II.3.
  //
  // FIX #12: Handles the case where provisional reads have no tab_id (the
  // reader had no tab when the provisional read was created). A tab is
  // ensured to exist before conversion.
  // ---------------------------------------------------------------------------

  async convertProvisionalReads(readerId: string): Promise<number> {
    return withTransaction(async (client) => {
      // Get all provisional reads for this reader
      const { rows: provisionalReads } = await client.query<{
        id: string
        amount_pence: number
      }>(
        `SELECT id, amount_pence
         FROM read_events
         WHERE reader_id = $1 AND state = 'provisional'
         FOR UPDATE`,
        [readerId]
      )

      if (provisionalReads.length === 0) return 0

      // FIX #12: Ensure the reader has a tab — they may not have had one
      // during the provisional period. Upsert to handle the race safely.
      const tabRow = await client.query<{ id: string }>(
        `INSERT INTO reading_tabs (reader_id)
         VALUES ($1)
         ON CONFLICT ON CONSTRAINT one_tab_per_reader
         DO UPDATE SET updated_at = now()
         RETURNING id`,
        [readerId]
      )
      const tabId = tabRow.rows[0].id

      const totalPence = provisionalReads.reduce((sum, r) => sum + r.amount_pence, 0)

      // Update all provisional reads to accrued, assigning the tab
      await client.query(
        `UPDATE read_events
         SET state = 'accrued',
             tab_id = $1,
             state_updated_at = now()
         WHERE reader_id = $2 AND state = 'provisional'`,
        [tabId, readerId]
      )

      // Also convert provisional vote_charges to accrued
      const { rows: provisionalVoteCharges } = await client.query<{ amount_pence: number }>(
        `UPDATE vote_charges
         SET state = 'accrued', tab_id = $1
         WHERE voter_id = $2 AND state = 'provisional'
         RETURNING amount_pence`,
        [tabId, readerId]
      )
      const voteChargeTotal = provisionalVoteCharges.reduce((sum, r) => sum + r.amount_pence, 0)

      // Add total to tab balance (reads + vote charges)
      await client.query(
        `UPDATE reading_tabs
         SET balance_pence = balance_pence + $1,
             last_read_at  = now(),
             updated_at    = now()
         WHERE id = $2`,
        [totalPence + voteChargeTotal, tabId]
      )

      logger.info(
        { readerId, convertedCount: provisionalReads.length, totalPence },
        'Provisional reads converted to accrued'
      )

      return provisionalReads.length
    })
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// FIX #10: Extracted async receipt publishing into a standalone async function
// so errors are reliably caught and logged. This replaces the setImmediate
// pattern which could silently swallow rejections.
async function publishReceiptAsync(readEvent: ReadEvent, event: GatePassEvent): Promise<void> {
  try {
    const articleNostrEventId = await getArticleNostrEventId(event.articleId)
    const writerPubkey = await getWriterPubkey(event.writerId)

    // Publish public kind 9901 to relay (uses keyed HMAC hash, not real pubkey)
    const nostrEventId = await publishReceiptEvent({
      readEventId: readEvent.id,
      articleNostrEventId,
      writerPubkey,
      readerPubkeyHash: event.readerPubkeyHash,
      amountPence: event.amountPence,
      tabId: event.tabId,
    })

    // Create portable receipt (private, not published — stored in DB for export)
    const receiptToken = createPortableReceipt({
      articleNostrEventId,
      writerPubkey,
      readerPubkey: event.readerPubkey,
      amountPence: event.amountPence,
    })

    await pool.query(
      `UPDATE read_events
       SET receipt_nostr_event_id = $1,
           reader_pubkey = $2,
           receipt_token = $3
       WHERE id = $4`,
      [nostrEventId, event.readerPubkey, receiptToken, readEvent.id]
    )
  } catch (err) {
    // Receipt failure never fails the read — it queues for retry
    logger.error({ err, readEventId: readEvent.id }, 'Receipt publish failed — will retry')
  }
}

async function getArticleNostrEventId(articleId: string): Promise<string> {
  const { rows } = await pool.query<{ nostr_event_id: string }>(
    'SELECT nostr_event_id FROM articles WHERE id = $1',
    [articleId]
  )
  if (!rows[0]?.nostr_event_id) {
    throw new Error(`Article not found or missing nostr_event_id: ${articleId}`)
  }
  return rows[0].nostr_event_id
}

async function getWriterPubkey(writerId: string): Promise<string> {
  const { rows } = await pool.query<{ nostr_pubkey: string }>(
    'SELECT nostr_pubkey FROM accounts WHERE id = $1',
    [writerId]
  )
  if (!rows[0]?.nostr_pubkey) {
    throw new Error(`Writer not found or missing nostr_pubkey: ${writerId}`)
  }
  return rows[0].nostr_pubkey
}

export const accrualService = new AccrualService()
