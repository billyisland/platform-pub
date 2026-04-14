import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// =============================================================================
// AES-256-GCM credential encryption
//
// Used to encrypt OAuth access / refresh tokens and Mastodon client secrets
// stored in linked_accounts.credentials_enc, oauth_app_registrations.
// client_secret_enc, and atproto_oauth_sessions.session_data_enc.
//
// Storage format (base64url, single string):
//   v0 (legacy, no version byte): base64url(iv ‖ authTag ‖ ciphertext)
//   v1+ (versioned):              base64url(0x01 ‖ iv ‖ authTag ‖ ciphertext)
//                                       where the leading byte encodes the key
//                                       version used to encrypt the row.
//
// Multiple keys can be kept active for rollover: writes always use
// LINKED_ACCOUNT_KEY_HEX (the current key); decryption also tries
// LINKED_ACCOUNT_KEY_HEX_V{n} fallbacks keyed by the version byte.
// Legacy (unversioned) blobs are detected by length and fall back to the
// current key, matching the pre-versioning behaviour.
// =============================================================================

const IV_LEN = 12
const TAG_LEN = 16
const CURRENT_KEY_VERSION = 1

function parseHexKey(hex: string): Buffer {
  if (hex.length !== 64) throw new Error('Key material must be 64 hex chars (32 bytes)')
  return Buffer.from(hex, 'hex')
}

function getCurrentKey(): Buffer {
  const hex = process.env.LINKED_ACCOUNT_KEY_HEX
  if (!hex) throw new Error('LINKED_ACCOUNT_KEY_HEX is not set')
  return parseHexKey(hex)
}

// Resolve the key for a given version byte. Version 1 == current key.
// Older versions pull from LINKED_ACCOUNT_KEY_HEX_V{n} so an operator can
// keep a previous key active during a rollover window without rewriting
// every encrypted row in a single deploy.
function getKeyForVersion(version: number): Buffer {
  if (version === CURRENT_KEY_VERSION) return getCurrentKey()
  const env = process.env[`LINKED_ACCOUNT_KEY_HEX_V${version}`]
  if (!env) throw new Error(`No key material available for version ${version}`)
  return parseHexKey(env)
}

export function encryptCredentials(plaintext: string): string {
  const key = getCurrentKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const versionByte = Buffer.from([CURRENT_KEY_VERSION])
  return Buffer.concat([versionByte, iv, tag, ct]).toString('base64url')
}

export function decryptCredentials(blob: string): string {
  const buf = Buffer.from(blob, 'base64url')

  // Detect format by length. The legacy (v0) layout is iv ‖ tag ‖ ct, so the
  // minimum blob is IV_LEN + TAG_LEN + 1 = 29 bytes. A versioned blob adds one
  // leading byte, so the minimum is 30. Anything shorter is corrupt.
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('Ciphertext too short')

  // Versioned format: the first byte is a small integer (1..255) that doesn't
  // collide with the first byte of a random 12-byte IV in any ambiguous way —
  // legacy blobs also start with a random byte, so there's no clean way to
  // disambiguate purely by content. We treat anything whose first byte matches
  // a known version *and* whose remainder is long enough as versioned; any
  // blob without a known version is decrypted with the current key (legacy).
  const maybeVersion = buf[0]
  const isVersioned = (maybeVersion >= 1 && maybeVersion <= 8) &&
    buf.length >= 1 + IV_LEN + TAG_LEN + 1

  if (isVersioned) {
    try {
      const key = getKeyForVersion(maybeVersion)
      const iv = buf.subarray(1, 1 + IV_LEN)
      const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN)
      const ct = buf.subarray(1 + IV_LEN + TAG_LEN)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const pt = Buffer.concat([decipher.update(ct), decipher.final()])
      return pt.toString('utf8')
    } catch {
      // Fall through to legacy path — the leading byte happened to collide
      // with a valid version number but the row is actually a v0 blob.
    }
  }

  // Legacy (v0): no version byte, full buf is iv ‖ tag ‖ ct, current key.
  const key = getCurrentKey()
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
