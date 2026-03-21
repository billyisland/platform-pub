import { generateSecretKey, getPublicKey, finalizeEvent, nip44 } from 'nostr-tools'
import type { EventTemplate } from 'nostr-tools'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { pool } from '../db/client.js'

// =============================================================================
// Custodial keypair crypto
//
// ACCOUNT_KEY_HEX is the master key that encrypts all user Nostr private keys
// at rest. It lives only in this service — the gateway and other services
// never see it.
//
// Format: base64(iv[12] + authTag[16] + ciphertext[32])
// =============================================================================

export interface GeneratedKeypair {
  pubkeyHex: string
  privkeyEncrypted: string
}

// ---------------------------------------------------------------------------
// generateKeypair — called once per account at signup
// ---------------------------------------------------------------------------

export function generateKeypair(): GeneratedKeypair {
  const privkey = generateSecretKey()
  const pubkey = getPublicKey(privkey)
  const privkeyEncrypted = encryptPrivkey(Buffer.from(privkey))
  return { pubkeyHex: pubkey, privkeyEncrypted }
}

// ---------------------------------------------------------------------------
// signEvent — sign a Nostr event on behalf of an account
// ---------------------------------------------------------------------------

export async function signEvent(
  accountId: string,
  eventTemplate: EventTemplate
): Promise<ReturnType<typeof finalizeEvent>> {
  const privkeyBytes = await getDecryptedPrivkey(accountId)
  try {
    return finalizeEvent(eventTemplate, new Uint8Array(privkeyBytes))
  } finally {
    privkeyBytes.fill(0)
  }
}

// ---------------------------------------------------------------------------
// unwrapKey — decrypt a NIP-44 payload using the account's private key
//
// The key-service wraps content keys with NIP-44 using the platform service
// keypair as sender and the reader's pubkey as recipient. This reverses that.
// ---------------------------------------------------------------------------

export async function unwrapKey(
  accountId: string,
  encryptedKey: string
): Promise<string> {
  const privkeyBytes = await getDecryptedPrivkey(accountId)
  try {
    const readerPrivkey = new Uint8Array(privkeyBytes)
    const servicePubkey = getServicePubkey()
    const conversationKey = nip44.getConversationKey(readerPrivkey, servicePubkey)
    return nip44.decrypt(encryptedKey, conversationKey)
  } finally {
    privkeyBytes.fill(0)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getDecryptedPrivkey(accountId: string): Promise<Buffer> {
  const { rows } = await pool.query<{ nostr_privkey_enc: string | null }>(
    'SELECT nostr_privkey_enc FROM accounts WHERE id = $1',
    [accountId]
  )
  if (rows.length === 0) throw new Error(`Account not found: ${accountId}`)
  const enc = rows[0].nostr_privkey_enc
  if (!enc) throw new Error(`Account ${accountId} has no custodial keypair`)
  return decryptPrivkey(enc)
}

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

function getServicePubkey(): string {
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY
  if (!privkeyHex) throw new Error('PLATFORM_SERVICE_PRIVKEY not set')
  return getPublicKey(Uint8Array.from(Buffer.from(privkeyHex, 'hex')))
}
