import { randomUUID } from 'crypto'
import { pool, withTransaction } from '../db/client.js'
import { generateContentKey, encryptContentKey, decryptContentKey } from '../lib/kms.js'
import { encryptArticleBody } from '../lib/crypto.js'
import { wrapKeyForReader } from '../lib/nip44.js'
import { verifyPayment, resolveArticleId } from './verification.js'
import type { VaultEncryptResult, KeyResponse } from '../types/index.js'
import logger from '../lib/logger.js'

// =============================================================================
// VaultService
//
// Two responsibilities:
//
//   1. publishArticle — called when a writer publishes a paywalled article.
//      Generates a content key, encrypts the paywalled body, stores the key,
//      and returns the vault event template for the relay.
//
//   2. issueKey — called when a reader passes a gate (or re-requests a key).
//      Verifies payment, retrieves the stored content key, wraps it with
//      NIP-44 to the reader's pubkey, and logs the issuance.
// =============================================================================

export class VaultService {

  // ---------------------------------------------------------------------------
  // publishArticle
  //
  // Called by the publishing route when a writer publishes a paywalled article.
  // Returns the vault event template — the caller publishes it to the relay.
  //
  // If the article already has a vault key (re-publish / edit), the existing
  // key is reused and the body is re-encrypted with the same key. Readers who
  // already have the key don't need to do anything — per ADR §II.4a.
  //
  // FIX #16: On edit, the vault key's nostr_article_event_id is updated to
  // point to the new NIP-23 event ID. Without this, issueKey (which looks up
  // vault keys by nostr_article_event_id) would fail for the new event ID.
  // ---------------------------------------------------------------------------

  async publishArticle(params: {
    articleId: string
    nostrArticleEventId: string
    paywallBody: string          // plaintext content after the gate
    pricePence: number
    gatePositionPct: number
    nostrDTag: string
  }): Promise<VaultEncryptResult> {

    return withTransaction(async (client) => {
      // Check if a key already exists (edit / re-publish)
      const existingKey = await client.query<{ id: string; content_key_enc: string }>(
        `SELECT id, content_key_enc FROM vault_keys WHERE article_id = $1`,
        [params.articleId]
      )

      let contentKeyBytes: Buffer
      let vaultKeyId: string

      if (existingKey.rowCount && existingKey.rowCount > 0) {
        // Reuse existing key — re-encrypt body, same key
        contentKeyBytes = decryptContentKey(existingKey.rows[0].content_key_enc)
        vaultKeyId = existingKey.rows[0].id

        // FIX #16: Update the vault key's event ID reference to the new
        // NIP-23 event ID. This is critical: issueKey looks up vault keys
        // by nostr_article_event_id, so if we don't update this, readers
        // fetching the new event will get VAULT_KEY_NOT_FOUND.
        await client.query(
          `UPDATE vault_keys
           SET nostr_article_event_id = $1
           WHERE id = $2`,
          [params.nostrArticleEventId, vaultKeyId]
        )

        logger.info({ articleId: params.articleId, vaultKeyId }, 'Reusing existing vault key for article edit — event ID updated')
      } else {
        // New article — generate fresh key
        contentKeyBytes = generateContentKey()
        const contentKeyEnc = encryptContentKey(contentKeyBytes)

        const keyRow = await client.query<{ id: string }>(
          `INSERT INTO vault_keys (article_id, nostr_article_event_id, content_key_enc, algorithm)
           VALUES ($1, $2, $3, 'aes-256-gcm')
           RETURNING id`,
          [params.articleId, params.nostrArticleEventId, contentKeyEnc]
        )
        vaultKeyId = keyRow.rows[0].id
        logger.info({ articleId: params.articleId, vaultKeyId }, 'Generated new vault key')
      }

      // Encrypt the paywalled body
      const ciphertext = encryptArticleBody(params.paywallBody, contentKeyBytes)

      // Build the vault event template (kind 39701)
      const vaultEventTemplate = {
        kind: 39701 as const,
        tags: [
          ['d', params.nostrDTag],
          ['e', params.nostrArticleEventId],
          ['encrypted', 'aes-256-gcm'],
          ['price', String(params.pricePence), 'GBP'],
          ['gate', String(params.gatePositionPct)],
        ],
        content: ciphertext,
      }

      // Store the vault event ID reference on the articles table
      // (The caller will sign and publish the event, then call updateVaultEventId)

      return {
        ciphertext,
        vaultKeyId,
        nostrVaultEvent: vaultEventTemplate,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // updateVaultEventId
  //
  // Called after the caller has signed and published the vault event to the
  // relay, so we have the final Nostr event ID to store.
  // ---------------------------------------------------------------------------

  async updateVaultEventId(articleId: string, vaultNostrEventId: string): Promise<void> {
    await pool.query(
      `UPDATE articles SET vault_event_id = $1, updated_at = now() WHERE id = $2`,
      [vaultNostrEventId, articleId]
    )
  }

  // ---------------------------------------------------------------------------
  // issueKey
  //
  // The core key service operation. Called by the web client after:
  //   - The payment service has recorded a gate pass (read_event written)
  //   - The reader's session is authenticated
  //
  // Flow:
  //   1. Resolve Nostr event ID → internal article UUID
  //   2. Verify payment record exists and is in a valid state
  //   3. Retrieve and decrypt content key from vault_keys
  //   4. Wrap content key with NIP-44 to reader's pubkey
  //   5. Log issuance (for re-issuance tracking and audit)
  //   6. Return wrapped key to caller
  //
  // FIX #15: Note on payment verification — the verification service accepts
  // reads in states: accrued, platform_settled, and writer_paid. This means
  // a reader whose card has not yet been charged (accrued) can still receive
  // a content key. This is an intentional design choice: the reader has a
  // card connected and a real payment obligation via their tab. Requiring
  // platform_settled would mean readers couldn't read until their tab was
  // charged by Stripe, introducing unacceptable latency. The accrued state
  // represents a binding obligation, not a speculative one.
  // ---------------------------------------------------------------------------

  async issueKey(params: {
    readerId: string
    readerPubkey: string
    articleNostrEventId: string
  }): Promise<KeyResponse> {
    // Step 1: resolve Nostr event ID → internal IDs
    const resolved = await resolveArticleId(params.articleNostrEventId)
    if (!resolved) {
      throw new KeyServiceError('ARTICLE_NOT_FOUND', `No article found for event ID: ${params.articleNostrEventId}`)
    }

    // Step 2: verify payment
    const verification = await verifyPayment(params.readerId, resolved.articleId)
    if (!verification.isVerified) {
      const reason = verification.readEventExists ? 'PROVISIONAL_ONLY' : 'NO_PAYMENT_RECORD'
      throw new KeyServiceError('PAYMENT_NOT_VERIFIED', reason)
    }

    // Step 3: retrieve vault key
    const keyRow = await pool.query<{ id: string; content_key_enc: string }>(
      `SELECT id, content_key_enc FROM vault_keys
       WHERE nostr_article_event_id = $1`,
      [params.articleNostrEventId]
    )

    if (keyRow.rowCount === 0) {
      throw new KeyServiceError('VAULT_KEY_NOT_FOUND', `No vault key for article: ${params.articleNostrEventId}`)
    }

    const vaultKey = keyRow.rows[0]

    // Step 4: decrypt content key from KMS envelope, then re-wrap with NIP-44
    const contentKeyBytes = decryptContentKey(vaultKey.content_key_enc)
    const encryptedKey = wrapKeyForReader(contentKeyBytes, params.readerPubkey)

    // Step 5: log issuance
    const isReissuance = await this.logIssuance({
      vaultKeyId: vaultKey.id,
      readerId: params.readerId,
      articleId: resolved.articleId,
      readEventId: verification.readEventId,
    })

    logger.info(
      {
        readerId: params.readerId,
        articleId: resolved.articleId,
        isReissuance,
        paymentState: verification.state,
      },
      'Content key issued'
    )

    return {
      encryptedKey,
      articleNostrEventId: params.articleNostrEventId,
      algorithm: 'aes-256-gcm',
      isReissuance,
    }
  }

  // ---------------------------------------------------------------------------
  // logIssuance — records to content_key_issuances; returns true if re-issuance
  // ---------------------------------------------------------------------------

  private async logIssuance(params: {
    vaultKeyId: string
    readerId: string
    articleId: string
    readEventId: string | null
  }): Promise<boolean> {
    // Check if we've issued to this reader before
    const { rows: prior } = await pool.query<{ id: string }>(
      `SELECT id FROM content_key_issuances
       WHERE reader_id = $1 AND article_id = $2
       LIMIT 1`,
      [params.readerId, params.articleId]
    )

    const isReissuance = prior.length > 0

    await pool.query(
      `INSERT INTO content_key_issuances
         (vault_key_id, reader_id, article_id, read_event_id, is_reissuance)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.vaultKeyId, params.readerId, params.articleId, params.readEventId, isReissuance]
    )

    return isReissuance
  }
}

// ---------------------------------------------------------------------------
// Typed error class — routes can switch on code for HTTP status mapping
// ---------------------------------------------------------------------------

export class KeyServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'KeyServiceError'
  }
}

export const vaultService = new VaultService()
