// =============================================================================
// Key Service Types
// =============================================================================

export interface VaultEncryptResult {
  ciphertext: string          // base64-encoded AES-256-GCM ciphertext
  vaultKeyId: string          // UUID of the vault_keys row
  nostrVaultEvent: {
    kind: 39701
    tags: string[][]
    content: string           // the ciphertext
  }
}

export interface KeyResponse {
  encryptedKey: string        // NIP-44 wrapped content key
  articleNostrEventId: string
  algorithm: string           // 'aes-256-gcm'
  isReissuance: boolean
}

export interface PaymentVerification {
  isVerified: boolean
  readEventId: string | null
  state: 'accrued' | 'platform_settled' | 'writer_paid' | null
  readEventExists: boolean
}
