import type { EventTemplate } from 'nostr-tools'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Key Custody Client
//
// Internal HTTP client for the key-custody service. All private-key operations
// (keypair generation, event signing, NIP-44 unwrapping) are delegated here.
// =============================================================================

function baseUrl(): string {
  const url = process.env.KEY_CUSTODY_URL
  if (!url) throw new Error('KEY_CUSTODY_URL not set')
  return url
}

function secret(): string {
  const s = process.env.INTERNAL_SECRET
  if (!s) throw new Error('INTERNAL_SECRET not set')
  return s
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Internal-Secret': secret(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw Object.assign(new Error(`key-custody ${path} failed: ${res.status}`), { upstream: err })
  }

  return res.json() as Promise<T>
}

export async function generateKeypair(): Promise<{ pubkeyHex: string; privkeyEncrypted: string }> {
  return post('/api/v1/keypairs/generate')
}

export async function signEvent(
  accountId: string,
  eventTemplate: EventTemplate
): Promise<{ id: string; pubkey: string; sig: string; kind: number; content: string; tags: string[][]; created_at: number }> {
  return post('/api/v1/keypairs/sign', { accountId, event: eventTemplate })
}

export async function unwrapKey(
  accountId: string,
  encryptedKey: string
): Promise<{ contentKeyBase64: string }> {
  return post('/api/v1/keypairs/unwrap', { accountId, encryptedKey })
}

export async function nip44Encrypt(
  accountId: string,
  recipientPubkey: string,
  plaintext: string
): Promise<{ ciphertext: string }> {
  return post('/api/v1/keypairs/nip44-encrypt', { accountId, recipientPubkey, plaintext })
}

export async function nip44Decrypt(
  accountId: string,
  senderPubkey: string,
  ciphertext: string
): Promise<{ plaintext: string }> {
  return post('/api/v1/keypairs/nip44-decrypt', { accountId, senderPubkey, ciphertext })
}
