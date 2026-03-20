import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { vaultService, KeyServiceError } from '../services/vault.js'
import { pool } from '../db/client.js'
import logger from '../lib/logger.js'

// =============================================================================
// Key Service Routes
//
// POST /articles/:nostrEventId/vault   — publish: encrypt body + store key
// POST /articles/:nostrEventId/key     — issue: verify payment + return NIP-44 key
// PATCH /articles/:nostrEventId/vault  — update vault event ID after relay publish
//
// Auth: all routes require a valid session token (verified at gateway).
// The gateway injects x-reader-id and x-reader-pubkey headers after verification.
// The publish route requires x-writer-id instead.
// =============================================================================

const PublishVaultSchema = z.object({
  articleId: z.string().uuid(),
  paywallBody: z.string().min(1),
  pricePence: z.number().int().positive(),
  gatePositionPct: z.number().int().min(1).max(99),
  nostrDTag: z.string().min(1),
})

const UpdateVaultEventIdSchema = z.object({
  vaultNostrEventId: z.string().length(64),   // hex Nostr event ID
})

export async function keyRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /articles/:nostrEventId/vault
  // Called by the publishing pipeline after the writer hits publish.
  // Encrypts the paywalled body and stores the content key.
  // Returns the vault event template for the caller to sign and publish.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/vault',
    async (req, reply) => {
      const writerId = req.headers['x-writer-id']
      if (!writerId || typeof writerId !== 'string') {
        return reply.status(401).send({ error: 'Missing x-writer-id' })
      }

      const parsed = PublishVaultSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      // Verify the writer owns this article
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM articles
         WHERE id = $1 AND writer_id = $2 AND nostr_event_id = $3`,
        [parsed.data.articleId, writerId, req.params.nostrEventId]
      )

      if (rows.length === 0) {
        return reply.status(403).send({ error: 'Article not found or not owned by writer' })
      }

      try {
        const result = await vaultService.publishArticle({
          articleId: parsed.data.articleId,
          nostrArticleEventId: req.params.nostrEventId,
          paywallBody: parsed.data.paywallBody,
          pricePence: parsed.data.pricePence,
          gatePositionPct: parsed.data.gatePositionPct,
          nostrDTag: parsed.data.nostrDTag,
        })

        return reply.status(201).send({
          vaultKeyId: result.vaultKeyId,
          nostrVaultEvent: result.nostrVaultEvent,
          // ciphertext not returned — it's embedded in the vault event
        })
      } catch (err) {
        logger.error({ err, writerId, nostrEventId: req.params.nostrEventId }, 'Vault publish failed')
        return reply.status(500).send({ error: 'Vault publish failed' })
      }
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /articles/:nostrEventId/vault
  // After the caller signs and publishes the vault event to the relay,
  // they report the final Nostr event ID back so we can store the reference.
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/vault',
    async (req, reply) => {
      const writerId = req.headers['x-writer-id']
      if (!writerId || typeof writerId !== 'string') {
        return reply.status(401).send({ error: 'Missing x-writer-id' })
      }

      const parsed = UpdateVaultEventIdSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM articles WHERE nostr_event_id = $1 AND writer_id = $2`,
        [req.params.nostrEventId, writerId]
      )

      if (rows.length === 0) {
        return reply.status(403).send({ error: 'Article not found or not owned by writer' })
      }

      await vaultService.updateVaultEventId(rows[0].id, parsed.data.vaultNostrEventId)
      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /articles/:nostrEventId/key
  // Called by the web client when a reader passes a gate.
  // Verifies payment, issues the NIP-44 encrypted content key.
  //
  // Rate-limited: 10 requests per reader per minute — prevents key-fishing.
  // (The rate limit plugin is registered on the app instance at startup.)
  // ---------------------------------------------------------------------------

  app.post<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/key',
    async (req, reply) => {
      const readerId = req.headers['x-reader-id']
      const readerPubkey = req.headers['x-reader-pubkey']

      if (!readerId || typeof readerId !== 'string') {
        return reply.status(401).send({ error: 'Missing x-reader-id' })
      }
      if (!readerPubkey || typeof readerPubkey !== 'string') {
        return reply.status(401).send({ error: 'Missing x-reader-pubkey' })
      }

      try {
        const keyResponse = await vaultService.issueKey({
          readerId,
          readerPubkey,
          articleNostrEventId: req.params.nostrEventId,
        })

        return reply.status(200).send(keyResponse)
      } catch (err) {
        if (err instanceof KeyServiceError) {
          const statusMap: Record<string, number> = {
            ARTICLE_NOT_FOUND: 404,
            PAYMENT_NOT_VERIFIED: 402,
            PROVISIONAL_ONLY: 402,
            NO_PAYMENT_RECORD: 402,
            VAULT_KEY_NOT_FOUND: 404,
          }
          const status = statusMap[err.code] ?? 500
          return reply.status(status).send({ error: err.code, message: err.message })
        }

        logger.error({ err, readerId, nostrEventId: req.params.nostrEventId }, 'Key issuance failed')
        return reply.status(500).send({ error: 'Key issuance failed' })
      }
    }
  )
}
