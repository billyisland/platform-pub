import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { signEvent, unwrapKey } from '../lib/key-custody-client.js'
import { publishToRelay } from '../lib/nostr-publisher.js'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Signing Routes
//
// The gateway's signing service. Delegates all private-key operations to the
// key-custody service — the gateway never sees ACCOUNT_KEY_HEX.
//
//   POST /sign          — Sign a Nostr event with the writer's custodial key.
//   POST /unwrap-key    — Decrypt a NIP-44 wrapped content key for a reader.
// =============================================================================

const SignEventSchema = z.object({
  kind: z.number().int(),
  content: z.string(),
  tags: z.array(z.array(z.string())),
  created_at: z.number().int().optional(),
  publicationId: z.string().uuid().optional(),
})

const UnwrapKeySchema = z.object({
  encryptedKey: z.string().min(1),
})

export async function signingRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /sign — sign a Nostr event
  // ---------------------------------------------------------------------------

  app.post('/sign', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SignEventSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!
    const { publicationId } = parsed.data

    // If signing as a publication, verify caller has can_publish
    if (publicationId) {
      const { rows } = await pool.query(
        `SELECT can_publish FROM publication_members
         WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
        [publicationId, accountId]
      )
      if (rows.length === 0 || !rows[0].can_publish) {
        return reply.status(403).send({ error: 'Not authorized to sign as this publication' })
      }
    }

    const signerId = publicationId ?? accountId
    const signerType = publicationId ? 'publication' as const : 'account' as const

    try {
      const signed = await signEvent(signerId, {
        kind: parsed.data.kind,
        content: parsed.data.content,
        tags: parsed.data.tags,
        created_at: parsed.data.created_at ?? Math.floor(Date.now() / 1000),
      }, signerType)
      logger.info({ signerId, signerType, eventKind: parsed.data.kind, eventId: signed.id }, 'Event signed')
      return reply.status(200).send(signed)
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'Event signing failed')
      return reply.status(500).send({ error: 'Signing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /sign-and-publish — sign a Nostr event and publish it to the relay
  //
  // Combines signing and relay publishing into a single call so the web client
  // does not need direct relay access. Returns the signed event data.
  // ---------------------------------------------------------------------------

  app.post('/sign-and-publish', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SignEventSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!
    const { publicationId } = parsed.data

    // If signing as a publication, verify caller has can_publish
    if (publicationId) {
      const { rows } = await pool.query(
        `SELECT can_publish FROM publication_members
         WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
        [publicationId, accountId]
      )
      if (rows.length === 0 || !rows[0].can_publish) {
        return reply.status(403).send({ error: 'Not authorized to sign as this publication' })
      }
    }

    const signerId = publicationId ?? accountId
    const signerType = publicationId ? 'publication' as const : 'account' as const

    try {
      const signed = await signEvent(signerId, {
        kind: parsed.data.kind,
        content: parsed.data.content,
        tags: parsed.data.tags,
        created_at: parsed.data.created_at ?? Math.floor(Date.now() / 1000),
      }, signerType)

      await publishToRelay(signed as any)

      logger.info({ signerId, signerType, eventKind: parsed.data.kind, eventId: signed.id }, 'Event signed and published')
      return reply.status(200).send(signed)
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'Sign-and-publish failed')
      return reply.status(500).send({ error: 'Sign-and-publish failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /unwrap-key — decrypt a NIP-44 wrapped content key
  // ---------------------------------------------------------------------------

  app.post('/unwrap-key', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = UnwrapKeySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!

    try {
      const result = await unwrapKey(accountId, parsed.data.encryptedKey)
      logger.debug({ accountId }, 'Content key unwrapped for reader')
      return reply.status(200).send(result)
    } catch (err) {
      logger.error({ err, accountId }, 'Key unwrapping failed')
      return reply.status(500).send({ error: 'Key unwrapping failed' })
    }
  })
}
