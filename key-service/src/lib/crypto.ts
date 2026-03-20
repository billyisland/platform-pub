import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

// =============================================================================
// Article Encryption
//
// Encrypts the paywalled body of an article with AES-256-GCM.
// The content key is a 32-byte random value generated per article at publish
// time and stored (envelope-encrypted) in vault_keys.
//
// Output stored in the vault event (kind 39701) content field as base64.
// Format: base64(iv[12] + authTag[16] + ciphertext[variable])
// =============================================================================

export function encryptArticleBody(
  plaintextBody: string,
  contentKeyBytes: Buffer
): string {
  if (contentKeyBytes.length !== 32) {
    throw new Error('Content key must be 32 bytes')
  }

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKeyBytes, iv)

  const bodyBuffer = Buffer.from(plaintextBody, 'utf8')
  const encrypted = Buffer.concat([cipher.update(bodyBuffer), cipher.final()])
  const authTag = cipher.getAuthTag()

  const combined = Buffer.concat([iv, authTag, encrypted])
  return combined.toString('base64')
}

export function decryptArticleBody(
  ciphertextBase64: string,
  contentKeyBytes: Buffer
): string {
  const combined = Buffer.from(ciphertextBase64, 'base64')

  const iv = combined.subarray(0, 12)
  const authTag = combined.subarray(12, 28)
  const ciphertext = combined.subarray(28)

  const decipher = createDecipheriv('aes-256-gcm', contentKeyBytes, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}
