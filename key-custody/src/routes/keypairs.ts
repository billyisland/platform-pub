import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { generateKeypair, signEvent, unwrapKey } from '../lib/crypto.js'
import logger from '../lib/logger.js'

// =============================================================================
// Keypair Routes — internal only
//
// All endpoints require the X-Internal-Secret header. They are not exposed
// to the public internet — the gateway calls them on behalf of authenticated
// users.
//
// POST /api/v1/keypairs/generate   — generate a keypair for a new account
// POST /api/v1/keypairs/sign       — sign a Nostr event for an account
// POST /api/v1/keypairs/unwrap     — unwrap a NIP-44 content key for a reader
// =============================================================================

function requireInternalSecret(req: any, reply: any, done: () => void) {
  const secret = process.env.INTERNAL_SECRET
  if (!secret) {
    // If no secret configured, reject all requests
    reply.status(503).send({ error: 'Service misconfigured' })
    return
  }
  if (req.headers['x-internal-secret'] !== secret) {
    reply.status(401).send({ error: 'Unauthorized' })
    return
  }
  done()
}

const SignEventSchema = z.object({
  accountId: z.string().uuid(),
  event: z.object({
    kind: z.number().int(),
    content: z.string(),
    tags: z.array(z.array(z.string())),
    created_at: z.number().int().optional(),
  }),
})

const UnwrapKeySchema = z.object({
  accountId: z.string().uuid(),
  encryptedKey: z.string().min(1),
})

export async function keypairRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/generate
  //
  // Generates a new Nostr keypair. Returns the public key and the
  // encrypted private key for storage in the accounts table.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/generate', { preHandler: requireInternalSecret }, async (_req, reply) => {
    try {
      const keypair = generateKeypair()
      return reply.status(201).send(keypair)
    } catch (err) {
      logger.error({ err }, 'Keypair generation failed')
      return reply.status(500).send({ error: 'Keypair generation failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/sign
  //
  // Signs a Nostr event template with the account's custodial private key.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/sign', { preHandler: requireInternalSecret }, async (req, reply) => {
    const parsed = SignEventSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { accountId, event } = parsed.data

    try {
      const eventTemplate = {
        kind: event.kind,
        content: event.content,
        tags: event.tags,
        created_at: event.created_at ?? Math.floor(Date.now() / 1000),
      }

      const signed = await signEvent(accountId, eventTemplate)

      logger.info({ accountId, eventKind: event.kind, eventId: signed.id }, 'Event signed')

      return reply.status(200).send({
        id: signed.id,
        pubkey: signed.pubkey,
        sig: signed.sig,
        kind: signed.kind,
        content: signed.content,
        tags: signed.tags,
        created_at: signed.created_at,
      })
    } catch (err) {
      logger.error({ err, accountId }, 'Event signing failed')
      return reply.status(500).send({ error: 'Signing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/unwrap
  //
  // Decrypts a NIP-44 wrapped content key using the reader's private key.
  // The key-service wrapped the content key to the reader's pubkey; this
  // reverses that using the reader's custodial private key.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/unwrap', { preHandler: requireInternalSecret }, async (req, reply) => {
    const parsed = UnwrapKeySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { accountId, encryptedKey } = parsed.data

    try {
      const contentKeyBase64 = await unwrapKey(accountId, encryptedKey)

      logger.debug({ accountId }, 'Content key unwrapped for reader')

      return reply.status(200).send({ contentKeyBase64 })
    } catch (err) {
      logger.error({ err, accountId }, 'Key unwrapping failed')
      return reply.status(500).send({ error: 'Key unwrapping failed' })
    }
  })
}
