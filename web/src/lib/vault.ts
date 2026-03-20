// =============================================================================
// Vault Decryption (Client-Side)
//
// After the key service issues a NIP-44 wrapped content key, the client
// needs to decrypt the vault event ciphertext. The flow:
//
//   1. Key service returns encryptedKey (NIP-44 wrapped AES-256 content key)
//   2. Client asks the gateway's signing service to unwrap the NIP-44 payload
//      (the reader's private key is custodial — held server-side)
//   3. Client receives the raw AES-256-GCM content key
//   4. Client decrypts the vault event ciphertext locally (Web Crypto API)
//   5. Decrypted markdown is rendered in the article view
//
// Step 4 runs entirely in the browser — the plaintext article body never
// touches the server after decryption. This is a genuine privacy property:
// the platform can see *that* a reader read an article, but the decrypted
// body is reconstructed client-side.
//
// Note: At launch with custodial keys, the signing service could technically
// decrypt server-side. The client-side decryption is a design choice that
// makes the transition to self-custodied keys seamless.
// =============================================================================

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''

/**
 * Decrypt a vault event's ciphertext using a content key.
 *
 * The ciphertext format (from key-service/src/lib/crypto.ts):
 *   base64(iv[12] + authTag[16] + ciphertext[variable])
 */
export async function decryptVaultContent(
  ciphertextBase64: string,
  contentKeyBase64: string
): Promise<string> {
  // Decode the content key
  const keyBytes = base64ToBuffer(contentKeyBase64)

  // Import as AES-GCM key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )

  // Decode the ciphertext
  const combined = base64ToBuffer(ciphertextBase64)

  // Extract iv (12 bytes), authTag (16 bytes), and ciphertext
  const iv = combined.slice(0, 12)
  const authTag = combined.slice(12, 28)
  const encrypted = combined.slice(28)

  // Web Crypto API expects authTag appended to ciphertext
  const ciphertextWithTag = new Uint8Array(encrypted.byteLength + authTag.byteLength)
  ciphertextWithTag.set(new Uint8Array(encrypted), 0)
  ciphertextWithTag.set(new Uint8Array(authTag), encrypted.byteLength)

  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    cryptoKey,
    ciphertextWithTag
  )

  return new TextDecoder().decode(decrypted)
}

/**
 * Unwrap a NIP-44 encrypted content key via the signing service.
 * The signing service holds the reader's custodial private key.
 *
 * Returns the raw content key as base64.
 */
export async function unwrapContentKey(
  encryptedKey: string
): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/api/v1/unwrap-key`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedKey }),
  })

  if (!res.ok) {
    throw new Error(`Key unwrapping failed: ${res.status}`)
  }

  const { contentKeyBase64 } = await res.json()
  return contentKeyBase64
}

/**
 * Full unlock flow: request key → unwrap → decrypt vault → return plaintext
 */
export async function unlockArticle(
  articleNostrEventId: string,
  vaultCiphertextBase64: string
): Promise<string> {
  // Step 1: Request the content key (NIP-44 wrapped)
  const res = await fetch(`${GATEWAY_URL}/api/v1/articles/${articleNostrEventId}/key`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  })

  if (!res.ok) {
    throw new Error(`Key request failed: ${res.status}`)
  }

  const { encryptedKey } = await res.json()

  // Step 2: Unwrap the NIP-44 envelope (server-side — custodial key)
  const contentKeyBase64 = await unwrapContentKey(encryptedKey)

  // Step 3: Decrypt the vault ciphertext (client-side — Web Crypto)
  const plaintext = await decryptVaultContent(vaultCiphertextBase64, contentKeyBase64)

  return plaintext
}

// =============================================================================
// Helpers
// =============================================================================

function base64ToBuffer(base64: string): ArrayBuffer {
  // Handle both standard and URL-safe base64
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
