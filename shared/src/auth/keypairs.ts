import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'
import type { EventTemplate } from 'nostr-tools'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { pool } from '../db/client.js'
import logger from '../lib/logger.js'

// =============================================================================
// Custodial Keypair Service (Signing Service)
//
// Per ADR §II.4a:
//   "Readers, like writers, receive a custodially managed Nostr keypair on
//    account creation. The platform's signing service handles all cryptographic
//    operations on the reader's behalf."
//
// This service:
//   1. Generates Nostr keypairs on account creation
//   2. Stores private keys encrypted at rest (AES-256-GCM with platform key)
//   3. Signs Nostr events on behalf of users
//   4. Decrypts NIP-44 payloads on behalf of readers (content key delivery)
//
// The private key encryption uses a separate key from the vault KMS key.
// This is deliberate: compromising one key does not compromise the other.
//
// Users never see or handle their private key. The platform UI shows their
// npub (public key in bech32) for display purposes only.
// =============================================================================

// ---------------------------------------------------------------------------
// generateKeypair — called once per account at signup
// Returns the hex pubkey and the encrypted privkey for DB storage.
// ---------------------------------------------------------------------------

export interface GeneratedKeypair {
  pubkeyHex: string
  privkeyEncrypted: string   // base64(iv[12] + authTag[16] + ciphertext[32])
}

export function generateKeypair(): GeneratedKeypair {
  const privkey = generateSecretKey()
  const pubkey = getPublicKey(privkey)

  const privkeyEncrypted = encryptPrivkey(Buffer.from(privkey))

  return {
    pubkeyHex: pubkey,
    privkeyEncrypted,
  }
}

// ---------------------------------------------------------------------------
// signEvent — signs a Nostr event on behalf of an account
//
// Retrieves the encrypted privkey from the DB, decrypts it, signs the event,
// and returns the finalized (signed) event. The privkey is held in memory
// only for the duration of the signing operation.
// ---------------------------------------------------------------------------

export async function signEvent(
  accountId: string,
  eventTemplate: EventTemplate
): Promise<ReturnType<typeof finalizeEvent>> {
  const privkeyBytes = await getDecryptedPrivkey(accountId)

  try {
    const privkey = new Uint8Array(privkeyBytes)
    const signedEvent = finalizeEvent(eventTemplate, privkey)
    return signedEvent
  } finally {
    // Zero out the key material after use
    privkeyBytes.fill(0)
  }
}

// ---------------------------------------------------------------------------
// getDecryptedPrivkey — retrieves and decrypts an account's private key
//
// Used internally by signEvent and by the key service's NIP-44 decryption
// (when unwrapping content keys on behalf of a reader).
// ---------------------------------------------------------------------------

export async function getDecryptedPrivkey(accountId: string): Promise<Buffer> {
  const { rows } = await pool.query<{ nostr_privkey_enc: string | null }>(
    'SELECT nostr_privkey_enc FROM accounts WHERE id = $1',
    [accountId]
  )

  if (rows.length === 0) {
    throw new Error(`Account not found: ${accountId}`)
  }

  const encryptedPrivkey = rows[0].nostr_privkey_enc
  if (!encryptedPrivkey) {
    throw new Error(`Account ${accountId} has no custodial keypair (self-custodied?)`)
  }

  return decryptPrivkey(encryptedPrivkey)
}

// ---------------------------------------------------------------------------
// getAccountPubkey — retrieves an account's public key (no decryption needed)
// ---------------------------------------------------------------------------

export async function getAccountPubkey(accountId: string): Promise<string> {
  const { rows } = await pool.query<{ nostr_pubkey: string }>(
    'SELECT nostr_pubkey FROM accounts WHERE id = $1',
    [accountId]
  )

  if (rows.length === 0) {
    throw new Error(`Account not found: ${accountId}`)
  }

  return rows[0].nostr_pubkey
}

// =============================================================================
// Private key encryption — AES-256-GCM with a dedicated platform key
//
// Separate from the vault KMS key (which encrypts content keys).
// Stored in ACCOUNT_KEY_HEX env var.
//
// Format: base64(iv[12] + authTag[16] + ciphertext[32])
// Same envelope format as vault KMS for consistency.
// =============================================================================

function getAccountKey(): Buffer {
  const keyHex = process.env.ACCOUNT_KEY_HEX
  if (!keyHex) throw new Error('ACCOUNT_KEY_HEX not set')
  const key = Buffer.from(keyHex, 'hex')
  if (key.length !== 32) throw new Error('ACCOUNT_KEY_HEX must be 32 bytes (64 hex chars)')
  return key
}

function encryptPrivkey(privkeyBytes: Buffer): string {
  const key = getAccountKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  const encrypted = Buffer.concat([cipher.update(privkeyBytes), cipher.final()])
  const authTag = cipher.getAuthTag()

  return Buffer.concat([iv, authTag, encrypted]).toString('base64')
}

function decryptPrivkey(encryptedBase64: string): Buffer {
  const key = getAccountKey()
  const combined = Buffer.from(encryptedBase64, 'base64')

  const iv = combined.subarray(0, 12)
  const authTag = combined.subarray(12, 28)
  const ciphertext = combined.subarray(28)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
