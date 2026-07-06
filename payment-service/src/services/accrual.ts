import type {
  GatePassEvent,
  ReadEvent,
} from "../types/index.js";
import {
  pool,
  withTransaction,
} from "@platform-pub/shared/db/client.js";
import { enqueueRelayPublish } from "@platform-pub/shared/lib/relay-outbox.js";
import { recordLedger } from "@platform-pub/shared/lib/ledger.js";
import { signReceiptEvent, createPortableReceipt } from "../lib/nostr.js";
import logger from "../lib/logger.js";

// =============================================================================
// Read classification — extracted as a pure function for testability
// =============================================================================

interface ReadClassification {
  readState: "provisional" | "accrued";
  onFreeAllowance: boolean;
  allowanceJustExhausted: boolean;
}

// Audit F3 (2026-07-05): the hard-gate floor. A card-less read is REFUSED once
// `free_allowance_remaining_pence − amount < FREE_ALLOWANCE_FLOOR_PENCE` (default
// 0 = refuse the moment the read would push the allowance negative). This closes
// the unmetered-giveaway hole where a burner account unlocked the entire paid
// catalogue for free, the only consequence an ever-more-negative column.
const FREE_ALLOWANCE_FLOOR_PENCE = parseInt(
  process.env.FREE_ALLOWANCE_FLOOR_PENCE ?? "0",
  10,
);

/** Thrown by recordGatePass when a card-less read is refused at the F3 floor. */
export class AllowanceExhaustedError extends Error {
  constructor() {
    super("free_allowance_exhausted");
    this.name = "AllowanceExhaustedError";
  }
}

export function classifyRead(
  hasCard: boolean,
  freeAllowanceRemainingPence: number,
  amountPence: number,
): ReadClassification {
  const allowanceJustExhausted =
    !hasCard &&
    freeAllowanceRemainingPence > 0 &&
    freeAllowanceRemainingPence - amountPence <= 0;

  return {
    readState: hasCard ? "accrued" : "provisional",
    onFreeAllowance: !hasCard && freeAllowanceRemainingPence > 0,
    allowanceJustExhausted,
  };
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

class AccrualService {

  // ---------------------------------------------------------------------------
  // recordGatePass — the main entry point
  // Called synchronously in the gate-pass request path; must be fast.
  // ---------------------------------------------------------------------------

  async recordGatePass(
    event: GatePassEvent,
  ): Promise<{ readEvent: ReadEvent; allowanceJustExhausted: boolean }> {
    const result = await withTransaction(async (client) => {
      // Audit F7 (2026-07-05): serialise concurrent first-reads of this
      // (reader, article) so exactly one charges — the other blocks here and
      // sees the winner's committed read below. Released at txn end.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`,
        [event.readerId, event.articleId],
      );

      // Audit F7: idempotency. The access model is unlock-once, so there is at
      // most one charged read per (reader, article) ever. A pre-existing read
      // means a prior gate pass already charged — return it rather than charging
      // again. Covers both the serialised concurrent race above and the retry
      // window where the payment committed but the gateway's permanent-unlock
      // row (the usual short-circuit) had not yet been written.
      const existing = await client.query<ReadEvent>(
        `SELECT * FROM read_events
         WHERE reader_id = $1 AND article_id = $2
         ORDER BY read_at ASC LIMIT 1`,
        [event.readerId, event.articleId],
      );
      if (existing.rowCount! > 0) {
        return { readEvent: existing.rows[0], allowanceJustExhausted: false };
      }

      const readerRow = await client.query<{
        stripe_customer_id: string | null;
        free_allowance_remaining_pence: number;
      }>(
        `SELECT stripe_customer_id, free_allowance_remaining_pence
         FROM accounts WHERE id = $1 FOR UPDATE`,
        [event.readerId],
      );

      if (readerRow.rowCount === 0) {
        throw new Error(`Reader not found: ${event.readerId}`);
      }

      const reader = readerRow.rows[0];
      const hasCard = reader.stripe_customer_id !== null;

      // Audit F3: hard-gate the card-less path at the allowance floor. Card
      // holders always accrue (they pay), so the floor only bounds free reading.
      if (
        !hasCard &&
        reader.free_allowance_remaining_pence - event.amountPence <
          FREE_ALLOWANCE_FLOOR_PENCE
      ) {
        throw new AllowanceExhaustedError();
      }

      const classification = classifyRead(
        hasCard,
        reader.free_allowance_remaining_pence,
        event.amountPence,
      );
      const { readState, onFreeAllowance, allowanceJustExhausted } =
        classification;

      if (!hasCard) {
        await client.query(
          `UPDATE accounts
           SET free_allowance_remaining_pence = free_allowance_remaining_pence - $1,
               updated_at = now()
           WHERE id = $2`,
          [event.amountPence, event.readerId],
        );
      }

      const readEventRow = await client.query<ReadEvent>(
        `INSERT INTO read_events (
           reader_id, article_id, writer_id, tab_id,
           amount_pence, state, reader_pubkey_hash, on_free_allowance,
           publication_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
          event.publicationId ?? null,
        ],
      );

      const readEvent = readEventRow.rows[0];

      if (readState === "accrued") {
        await client.query(
          `SELECT id FROM reading_tabs WHERE id = $1 FOR UPDATE`,
          [event.tabId],
        );
        await client.query(
          `UPDATE reading_tabs
           SET balance_pence = balance_pence + $1,
               last_read_at  = now(),
               updated_at    = now()
           WHERE id = $2`,
          [event.amountPence, event.tabId],
        );

        // Ledger: reader debit (owes amountPence for this read). Emitted only
        // on the accrued path — exactly when the tab balance moves — so the
        // reader's SUM mirrors reading_tabs.balance_pence (see ledger.ts).
        await recordLedger(client, {
          accountId: event.readerId,
          counterpartyId: event.writerId,
          amountPence: -event.amountPence,
          triggerType: "read_accrual",
          refTable: "read_events",
          refId: readEvent.id,
        });
      }

      logger.info(
        {
          readEventId: readEvent.id,
          state: readState,
          amountPence: event.amountPence,
        },
        "Gate pass recorded",
      );

      return { readEvent, allowanceJustExhausted };
    });

    // Fire receipt publish AFTER the transaction commits so the read_event row
    // is visible to the receipt's own transaction.
    publishReceiptAsync(result.readEvent, event).catch(() => {});

    return result;
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
      // FIX #12: Ensure the reader has a tab — they may not have had one
      // during the provisional period. Upsert to handle the race safely.
      const tabRow = await client.query<{ id: string }>(
        `INSERT INTO reading_tabs (reader_id)
         VALUES ($1)
         ON CONFLICT ON CONSTRAINT one_tab_per_reader
         DO UPDATE SET updated_at = now()
         RETURNING id`,
        [readerId],
      );
      const tabId = tabRow.rows[0].id;

      // Audit F6 (2026-07-05): claim-and-read atomically via RETURNING instead of
      // SELECT-FOR-UPDATE then a separate blanket UPDATE. The old form summed the
      // selected rows, then ran a blanket `UPDATE … WHERE state='provisional'`
      // whose predicate could match a fresh provisional read a concurrent
      // recordGatePass committed in between — recordGatePass locks the ACCOUNT
      // row, not the individual read rows, so it does not block this converter.
      // That interloping row would flip to 'accrued' but be absent from both
      // totalPence (tab under-incremented) and the ledger loop (missing debit),
      // silently breaking the Phase-3 −SUM == balance invariant. Deriving the
      // total AND the ledger loop from exactly the flipped rows closes it — the
      // same RETURNING shape the vote-charges branch already used.
      const { rows: provisionalReads } = await client.query<{
        id: string;
        amount_pence: number;
        writer_id: string;
      }>(
        `UPDATE read_events
         SET state = 'accrued',
             tab_id = $1,
             state_updated_at = now()
         WHERE reader_id = $2 AND state = 'provisional'
         RETURNING id, amount_pence, writer_id`,
        [tabId, readerId],
      );

      const totalPence = provisionalReads.reduce(
        (sum, r) => sum + r.amount_pence,
        0,
      );

      // Audit F9 (2026-07-06): paid voting was removed, so there are no new
      // provisional vote_charges to convert. Historical vote_charges are left
      // inert (never converted here); only reads convert.
      if (provisionalReads.length === 0) {
        return 0;
      }

      // Add total to tab balance
      if (totalPence > 0) {
        await client.query(
          `UPDATE reading_tabs
           SET balance_pence = balance_pence + $1,
               last_read_at  = now(),
               updated_at    = now()
           WHERE id = $2`,
          [totalPence, tabId],
        );
      }

      // Ledger: these provisional reads never moved the tab when created (no
      // card ⇒ no balance). Conversion is the first tab movement, so the debit
      // entries are emitted here, one per converted row, summing to the tab
      // increment above.
      for (const r of provisionalReads) {
        await recordLedger(client, {
          accountId: readerId,
          counterpartyId: r.writer_id,
          amountPence: -r.amount_pence,
          triggerType: "read_accrual",
          refTable: "read_events",
          refId: r.id,
        });
      }

      // F3: the reader has committed to paying (connected a card), so their
      // provisional unlocks become permanent.
      await client.query(
        `UPDATE article_unlocks
         SET is_provisional = FALSE
         WHERE reader_id = $1 AND is_provisional = TRUE`,
        [readerId],
      );

      logger.info(
        { readerId, convertedCount: provisionalReads.length, totalPence },
        "Provisional reads converted to accrued",
      );

      return provisionalReads.length;
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// FIX #10: Extracted async receipt publishing into a standalone async function
// so errors are reliably caught and logged. This replaces the setImmediate
// pattern which could silently swallow rejections.
async function publishReceiptAsync(
  readEvent: ReadEvent,
  event: GatePassEvent,
): Promise<void> {
  try {
    const articleNostrEventId = await getArticleNostrEventId(event.articleId);
    const writerPubkey = await getWriterPubkey(event.writerId);

    const receiptEvent = signReceiptEvent({
      articleNostrEventId,
      writerPubkey,
      readerPubkeyHash: event.readerPubkeyHash,
      amountPence: event.amountPence,
      tabId: event.tabId,
    });

    // Portable receipt stays local — private to the reader, never on the relay.
    const receiptToken = createPortableReceipt({
      articleNostrEventId,
      writerPubkey,
      readerPubkey: event.readerPubkey,
      amountPence: event.amountPence,
    });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE read_events
         SET receipt_nostr_event_id = $1,
             reader_pubkey = $2,
             receipt_token = $3
         WHERE id = $4`,
        [receiptEvent.id, event.readerPubkey, receiptToken, readEvent.id],
      );
      await enqueueRelayPublish(client, {
        entityType: "receipt",
        entityId: readEvent.id,
        signedEvent: receiptEvent,
      });
    });
  } catch (err) {
    // Receipt failure never fails the read — relay_outbox owns retry.
    logger.error(
      { err, readEventId: readEvent.id },
      "Receipt publish failed — will retry",
    );
  }
}

async function getArticleNostrEventId(articleId: string): Promise<string> {
  const { rows } = await pool.query<{ nostr_event_id: string }>(
    "SELECT nostr_event_id FROM articles WHERE id = $1",
    [articleId],
  );
  if (!rows[0]?.nostr_event_id) {
    throw new Error(
      `Article not found or missing nostr_event_id: ${articleId}`,
    );
  }
  return rows[0].nostr_event_id;
}

async function getWriterPubkey(writerId: string): Promise<string> {
  const { rows } = await pool.query<{ nostr_pubkey: string }>(
    "SELECT nostr_pubkey FROM accounts WHERE id = $1",
    [writerId],
  );
  if (!rows[0]?.nostr_pubkey) {
    throw new Error(`Writer not found or missing nostr_pubkey: ${writerId}`);
  }
  return rows[0].nostr_pubkey;
}

export const accrualService = new AccrualService();
