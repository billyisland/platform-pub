import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// =============================================================================
// AES-256-GCM credential encryption
//
// Used to encrypt OAuth access / refresh tokens and Mastodon client secrets
// stored in linked_accounts.credentials_enc and oauth_app_registrations.
// client_secret_enc. LINKED_ACCOUNT_KEY_HEX is a 64-char hex string (32 bytes).
//
// Storage format (base64url, single string):
//   base64url(iv ‖ authTag ‖ ciphertext)
// where iv is 12 bytes, authTag is 16 bytes. No external dependencies beyond
// Node's built-in crypto; follows the same pattern as accounts.nostr_privkey_enc.
// =============================================================================

const IV_LEN = 12
const TAG_LEN = 16

function getKey(): Buffer {
  const hex = process.env.LINKED_ACCOUNT_KEY_HEX
  if (!hex) throw new Error('LINKED_ACCOUNT_KEY_HEX is not set')
  if (hex.length !== 64) throw new Error('LINKED_ACCOUNT_KEY_HEX must be 64 hex chars (32 bytes)')
  return Buffer.from(hex, 'hex')
}

export function encryptCredentials(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64url')
}

export function decryptCredentials(blob: string): string {
  const key = getKey()
  const buf = Buffer.from(blob, 'base64url')
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('Ciphertext too short')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

// Convenience: encrypt/decrypt a JSON-serialisable credentials object.
// Used for the DecryptedCredentials bag stored on linked_accounts.
export function encryptJson(value: unknown): string {
  return encryptCredentials(JSON.stringify(value))
}

export function decryptJson<T = unknown>(blob: string): T {
  return JSON.parse(decryptCredentials(blob)) as T
}
