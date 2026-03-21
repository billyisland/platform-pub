import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { signEvent, unwrapKey } from '../lib/key-custody-client.js'
import logger from '../../shared/src/lib/logger.js'

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

    try {
      const signed = await signEvent(accountId, {
        kind: parsed.data.kind,
        content: parsed.data.content,
        tags: parsed.data.tags,
        created_at: parsed.data.created_at ?? Math.floor(Date.now() / 1000),
      })
      logger.info({ accountId, eventKind: parsed.data.kind, eventId: signed.id }, 'Event signed')
      return reply.status(200).send(signed)
    } catch (err) {
      logger.error({ err, accountId }, 'Event signing failed')
      return reply.status(500).send({ error: 'Signing failed' })
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
