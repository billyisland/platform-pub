// =============================================================================
// Key Service Types
// =============================================================================

export interface VaultEncryptResult {
  ciphertext: string          // base64-encoded encrypted body
  algorithm: 'xchacha20poly1305' | 'aes-256-gcm'
  vaultKeyId: string          // UUID of the vault_keys row
  /** @deprecated Kind 39701 vault events are no longer published. Use ciphertext
   *  directly, embedding it as a ['payload', ciphertext, algorithm] tag in the
   *  NIP-23 kind 30023 event. Kept temporarily for any legacy callers. */
  nostrVaultEvent: {
    kind: 39701
    tags: string[][]
    content: string           // same as ciphertext
  }
}

export interface KeyResponse {
  encryptedKey: string        // NIP-44 wrapped content key
  articleNostrEventId: string
  algorithm: 'xchacha20poly1305' | 'aes-256-gcm'
  isReissuance: boolean
}

export interface PaymentVerification {
  isVerified: boolean
  readEventId: string | null
  state: 'accrued' | 'platform_settled' | 'writer_paid' | null
  readEventExists: boolean
}
