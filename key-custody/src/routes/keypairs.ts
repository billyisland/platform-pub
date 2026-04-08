import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { generateKeypair, signEvent, unwrapKey, nip44Encrypt, nip44Decrypt } from '../lib/crypto.js'
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
    reply.status(503).send({ error: 'Service misconfigured' })
    return
  }
  // Normalize header to string — Fastify can return string[] for duplicate headers
  const header = req.headers['x-internal-secret']
  const provided = Array.isArray(header) ? header[0] : header
  if (typeof provided !== 'string' || provided !== secret) {
    reply.status(401).send({ error: 'Unauthorized' })
    return
  }
  done()
}

const signerTypeEnum = z.enum(['account', 'publication']).default('account')

export const SignEventSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  event: z.object({
    kind: z.number().int(),
    content: z.string(),
    tags: z.array(z.array(z.string())),
    created_at: z.number().int().optional(),
  }),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

export const UnwrapKeySchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  encryptedKey: z.string().min(1),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

const HEX64_RE = /^[0-9a-f]{64}$/

const Nip44EncryptSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  recipientPubkey: z.string().regex(HEX64_RE),
  plaintext: z.string().min(1),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

const Nip44DecryptSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  senderPubkey: z.string().regex(HEX64_RE),
  ciphertext: z.string().min(1),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

/** Resolve signerId from either signerId or legacy accountId */
export function resolveSignerId(data: { signerId?: string; accountId?: string }): string {
  return data.signerId || data.accountId!
}

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

    const { event, signerType } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const eventTemplate = {
        kind: event.kind,
        content: event.content,
        tags: event.tags,
        created_at: event.created_at ?? Math.floor(Date.now() / 1000),
      }

      const signed = await signEvent(signerId, eventTemplate, signerType)

      logger.info({ signerId, signerType, eventKind: event.kind, eventId: signed.id }, 'Event signed')

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
      logger.error({ err, signerId, signerType }, 'Event signing failed')
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

    const { encryptedKey, signerType } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const contentKeyBase64 = await unwrapKey(signerId, encryptedKey, signerType)

      logger.debug({ signerId, signerType }, 'Content key unwrapped')

      return reply.status(200).send({ contentKeyBase64 })
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'Key unwrapping failed')
      return reply.status(500).send({ error: 'Key unwrapping failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/nip44-encrypt
  //
  // NIP-44 encrypt plaintext using the account's private key and a recipient
  // public key. Used by the gateway for DM E2E encryption.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/nip44-encrypt', { preHandler: requireInternalSecret }, async (req, reply) => {
    const parsed = Nip44EncryptSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { recipientPubkey, plaintext, signerType } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const ciphertext = await nip44Encrypt(signerId, recipientPubkey, plaintext, signerType)
      logger.debug({ signerId, signerType }, 'NIP-44 encrypted')
      return reply.status(200).send({ ciphertext })
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'NIP-44 encryption failed')
      return reply.status(500).send({ error: 'Encryption failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/nip44-decrypt
  //
  // NIP-44 decrypt ciphertext using the account's private key and the sender's
  // public key. Used by the gateway for DM E2E decryption.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/nip44-decrypt', { preHandler: requireInternalSecret }, async (req, reply) => {
    const parsed = Nip44DecryptSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { senderPubkey, ciphertext, signerType } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const plaintext = await nip44Decrypt(signerId, senderPubkey, ciphertext, signerType)
      logger.debug({ signerId, signerType }, 'NIP-44 decrypted')
      return reply.status(200).send({ plaintext })
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'NIP-44 decryption failed')
      return reply.status(500).send({ error: 'Decryption failed' })
    }
  })
}
