import { getNdk, KIND_ARTICLE, KIND_DELETION } from './ndk'
import { signViaGateway } from './sign'
import { articles as articlesApi } from './api'
import type { PublishData } from '../components/editor/ArticleEditor'
import type NDK from '@nostr-dev-kit/ndk'
import { NDKEvent } from '@nostr-dev-kit/ndk'

// =============================================================================
// Publishing Service
//
// Orchestrates the full article publishing pipeline:
//
//   1. Build and sign the NIP-23 article event v1 (free content only)
//   2. Publish v1 to the relay
//   3. Index v1 in the platform database → get back the article UUID
//   4. If paywalled:
//      a. Call key service to encrypt the paywall body (needs real article UUID)
//      b. Build NIP-23 event v2 with ['payload', ciphertext, algorithm] tag
//      c. Sign and publish v2 — replaces v1 on relay (same d-tag, kind 30023
//         is a replaceable event, relay keeps only the latest)
//      d. Re-index with v2 event ID (upsert — same d-tag, updates nostr_event_id)
//
// No separate kind 39701 vault event is produced. The encrypted body lives
// entirely inside the NIP-23 event, keeping the article self-contained per
// spec §III.2.
//
// The double-publish (v1 then v2) is necessary because the key service needs
// the article UUID (from step 3) before it can create the vault key, and the
// article UUID is only available after indexing, which requires v1's event ID.
// v1 is invisible to readers in practice — v2 replaces it in the same relay
// round-trip before any reader could fetch v1.
// =============================================================================

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''

interface PublishResult {
  articleEventId: string   // final NIP-23 event ID (v2 if paywalled, v1 otherwise)
  dTag: string
  articleId: string
}

export async function publishArticle(
  data: PublishData,
  writerPubkey: string,
  existingDTag?: string
): Promise<PublishResult> {
  const ndk = getNdk()
  await ndk.connect()

  const dTag = existingDTag ?? generateDTag(data.title)

  // Step 1: Build and publish NIP-23 v1 (free content only — no payload yet)
  const v1 = buildNip23Event(ndk, data, dTag, null)
  const signedV1 = await signViaGateway(v1)
  await signedV1.publish()

  // Step 2: Index v1 → get article UUID
  let articleId!: string
  try {
    const result = await articlesApi.index({
      nostrEventId: signedV1.id,
      dTag,
      title: data.title,
      content: data.freeContent,
      isPaywalled: data.isPaywalled,
      pricePence: data.pricePence,
      gatePositionPct: data.gatePositionPct,
    })
    articleId = result.articleId
  } catch (indexErr) {
    // Retract v1 from relay so it doesn't become a dead link
    try {
      const retract = new NDKEvent(ndk)
      retract.kind = KIND_DELETION
      retract.content = ''
      retract.tags = [
        ['e', signedV1.id!],
        ['a', `30023:${writerPubkey}:${dTag}`],
      ]
      await (await signViaGateway(retract)).publish()
    } catch { /* best-effort */ }
    throw indexErr
  }

  if (!data.isPaywalled || !data.paywallContent) {
    return { articleEventId: signedV1.id, dTag, articleId }
  }

  // Step 3: Encrypt the paywall body — needs articleId for vault key FK
  const { ciphertext, algorithm } = await encryptPaywallBody(
    signedV1.id,
    articleId,
    dTag,
    data
  )

  // Step 4: Build NIP-23 v2 with embedded payload tag, sign and publish
  // Kind 30023 is replaceable by [pubkey, d-tag] — v2 atomically replaces v1
  const v2 = buildNip23Event(ndk, data, dTag, { ciphertext, algorithm })
  const signedV2 = await signViaGateway(v2)

  // FIX: The NDK WebSocket connection may have gone stale during the vault
  // encryption round-trip (Steps 2–3 involve multiple HTTP calls to the
  // gateway and key service). Re-connect before publishing v2 to avoid the
  // "no relays available" error. If the first attempt still fails, retry
  // once with a fresh connection.
  try {
    await ndk.connect()
    await signedV2.publish()
  } catch (publishErr) {
    // Second attempt with a forced reconnect
    try {
      await ndk.connect()
      await signedV2.publish()
    } catch (retryErr) {
      // v2 failed to reach the relay. v1 (free-content-only, no payload tag)
      // is still live. Do NOT re-index with v2's event ID — that would create
      // an ID mismatch where the DB points to v2 but the relay only has v1,
      // causing "Could not find the encrypted content" on unlock attempts.
      //
      // Throw so the caller knows publishing the paywalled version failed.
      // The article is live as free-only (v1). The writer can retry.
      throw new Error(
        `Article published as free-only (relay did not accept the paywalled version). ` +
        `Please try editing and re-publishing. Original error: ${retryErr}`
      )
    }
  }

  // Step 5: Re-index with v2 event ID (upsert on nostr_event_id)
  // Only reached if v2 was successfully published to the relay above.
  await articlesApi.index({
    nostrEventId: signedV2.id,
    dTag,
    title: data.title,
    content: data.freeContent,
    isPaywalled: data.isPaywalled,
    pricePence: data.pricePence,
    gatePositionPct: data.gatePositionPct,
  })

  return { articleEventId: signedV2.id, dTag, articleId }
}

// =============================================================================
// Internal helpers
// =============================================================================

function buildNip23Event(
  ndk: NDK,
  data: PublishData,
  dTag: string,
  payload: { ciphertext: string; algorithm: string } | null
): NDKEvent {
  const event = new NDKEvent(ndk)
  event.kind = KIND_ARTICLE
  event.content = data.isPaywalled ? data.freeContent : data.content
  event.tags = [
    ['d', dTag],
    ['title', data.title],
    ['published_at', String(Math.floor(Date.now() / 1000))],
  ]

  if (data.isPaywalled) {
    event.tags.push(
      ['price', String(data.pricePence), 'GBP'],
      ['gate', String(data.gatePositionPct)]
    )
  }

  if (payload) {
    // Embed the encrypted paywall body directly in the NIP-23 event.
    // Readers extract this tag after paying; no separate vault event needed.
    event.tags.push(['payload', payload.ciphertext, payload.algorithm])
  }

  return event
}

async function encryptPaywallBody(
  articleEventId: string,
  articleId: string,
  dTag: string,
  data: PublishData
): Promise<{ ciphertext: string; algorithm: string }> {
  const res = await fetch(`${GATEWAY_URL}/api/v1/articles/${articleEventId}/vault`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      articleId,
      paywallBody: data.paywallContent,
      pricePence: data.pricePence,
      gatePositionPct: data.gatePositionPct,
      nostrDTag: dTag,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(`Vault encryption failed: ${res.status} — ${body?.error ?? 'unknown'}`)
  }

  const result = await res.json()
  return { ciphertext: result.ciphertext, algorithm: result.algorithm }
}

function generateDTag(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)

  const timestamp = Math.floor(Date.now() / 1000).toString(36)
  return `${slug}-${timestamp}`
}
