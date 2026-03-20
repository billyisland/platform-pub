import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { signEvent, getDecryptedPrivkey, getAccountPubkey } from '../../shared/src/auth/keypairs.js'
import { requireAuth } from '../middleware/auth.js'
import { nip44, getPublicKey } from 'nostr-tools'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Signing Routes
//
// The gateway's signing service. Handles two operations:
//
//   POST /sign          — Sign a Nostr event with the writer's custodial key.
//                         Called by the publishing pipeline after the editor
//                         constructs an event template.
//
//   POST /unwrap-key    — Decrypt a NIP-44 wrapped content key using the
//                         reader's custodial private key. Called by the web
//                         client after the key service issues an encrypted
//                         content key.
//
// Both operations require authentication. The custodial private key is
// decrypted from the database, used for the single operation, then zeroed.
//
// Per ADR §II.4a:
//   "The platform's signing service handles all cryptographic operations
//    on the reader's behalf, including decryption of NIP-44 encrypted
//    content keys. Readers never need to know encryption is happening."
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
  //
  // Accepts an event template (kind, content, tags) and returns the fully
  // signed event (id, pubkey, sig, created_at populated).
  //
  // Only writers can sign events (articles and vault events).
  // ---------------------------------------------------------------------------

  app.post('/sign', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SignEventSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!

    try {
      const eventTemplate = {
        kind: parsed.data.kind,
        content: parsed.data.content,
        tags: parsed.data.tags,
        created_at: parsed.data.created_at ?? Math.floor(Date.now() / 1000),
      }

      const signedEvent = await signEvent(accountId, eventTemplate)

      logger.info(
        { accountId, eventKind: parsed.data.kind, eventId: signedEvent.id },
        'Event signed'
      )

      return reply.status(200).send({
        id: signedEvent.id,
        pubkey: signedEvent.pubkey,
        sig: signedEvent.sig,
        kind: signedEvent.kind,
        content: signedEvent.content,
        tags: signedEvent.tags,
        created_at: signedEvent.created_at,
      })
    } catch (err) {
      logger.error({ err, accountId }, 'Event signing failed')
      return reply.status(500).send({ error: 'Signing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /unwrap-key — decrypt a NIP-44 wrapped content key
  //
  // The key service wraps content keys with NIP-44 using the platform service
  // keypair as sender and the reader's pubkey as recipient. To decrypt, we
  // need the reader's private key.
  //
  // Flow:
  //   1. Decrypt reader's custodial private key from DB
  //   2. Derive NIP-44 conversation key (reader privkey + service pubkey)
  //   3. Decrypt the NIP-44 payload → raw content key (base64)
  //   4. Return the content key to the client for AES-GCM decryption
  //
  // The content key is returned as base64 to the browser. The browser uses
  // Web Crypto API to decrypt the vault event ciphertext. The plaintext
  // article body never touches the server.
  // ---------------------------------------------------------------------------

  app.post('/unwrap-key', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = UnwrapKeySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const accountId = req.session!.sub!

    try {
      // Get the reader's custodial private key
      const privkeyBytes = await getDecryptedPrivkey(accountId)

      // Get the platform service public key (the NIP-44 sender)
      const servicePubkey = getServicePubkey()

      // Derive the NIP-44 conversation key
      const readerPrivkey = new Uint8Array(privkeyBytes)
      const conversationKey = nip44.getConversationKey(readerPrivkey, servicePubkey)

      // Decrypt the NIP-44 payload
      const contentKeyBase64 = nip44.decrypt(parsed.data.encryptedKey, conversationKey)

      // Zero the private key material
      privkeyBytes.fill(0)

      logger.debug({ accountId }, 'Content key unwrapped for reader')

      return reply.status(200).send({ contentKeyBase64 })
    } catch (err) {
      logger.error({ err, accountId }, 'Key unwrapping failed')
      return reply.status(500).send({ error: 'Key unwrapping failed' })
    }
  })
}

// ---------------------------------------------------------------------------
// Service pubkey — the platform service keypair used by the key service
// to NIP-44 encrypt content keys to readers.
// ---------------------------------------------------------------------------

function getServicePubkey(): string {
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY
  if (!privkeyHex) throw new Error('PLATFORM_SERVICE_PRIVKEY not set')
  const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'))
  return getPublicKey(privkey)
}
