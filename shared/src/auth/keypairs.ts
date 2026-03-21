import { pool } from '../db/client.js'

// =============================================================================
// Keypair utilities — public key operations only
//
// All private key operations (generation, signing, NIP-44 unwrapping) have
// moved to the key-custody service. The gateway calls key-custody over HTTP
// for any operation requiring a user's private key.
//
// This module retains only the public-key lookup used by other services.
// =============================================================================

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
