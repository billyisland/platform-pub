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
//   1. Build and sign the NIP-23 article event (kind 30023)
//   2. Publish the article event to the relay
//   3. Index the article in the platform database → get back the article UUID
//   4. If paywalled:
//      a. Call key service to encrypt the paywall body (passing the real UUID)
//      b. Sign the vault event
//      c. Publish the vault event to the relay
//      d. Report the vault event ID back to the key service
//      e. Update the article index with the vault event ID
//
// FIX: The original pipeline called the vault endpoint with articleId: ''
// because the article hadn't been indexed yet. The vault key's article_id
// foreign key requires a valid UUID. The fix: index first, vault second.
// The vault endpoint's article ownership check (writer_id + nostr_event_id)
// now works because the row exists before the vault call arrives.
//
// Per ADR §II.4a: "The writer publishes once. The platform generates both
// events transparently."
// =============================================================================

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''

interface PublishResult {
  articleEventId: string
  vaultEventId?: string
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

  // Use existing d-tag when editing, generate new one for new articles
  const dTag = existingDTag ?? generateDTag(data.title)

  // Step 1: Build the NIP-23 article event
  const articleEvent = new NDKEvent(ndk)
  articleEvent.kind = KIND_ARTICLE
  articleEvent.content = data.isPaywalled ? data.freeContent : data.content
  articleEvent.tags = [
    ['d', dTag],
    ['title', data.title],
    ['published_at', String(Math.floor(Date.now() / 1000))],
  ]

  if (data.isPaywalled) {
    articleEvent.tags.push(
      ['price', String(data.pricePence), 'GBP'],
      ['gate', String(data.gatePositionPct)]
    )
  }

  // Step 2: Sign and publish the article event to the relay
  const signedArticle = await signViaGateway(articleEvent)
  await signedArticle.publish()

  // Step 3: Index the article in the platform database — this returns the UUID
  // that the vault key service needs as a foreign key reference.
  // If indexing fails we retract the relay event so it doesn't appear in feeds
  // as a dead link (visible on relay but 404 in the DB).
  let articleId!: string
  try {
    const result = await articlesApi.index({
      nostrEventId: signedArticle.id,
      dTag,
      title: data.title,
      content: data.freeContent,
      isPaywalled: data.isPaywalled,
      pricePence: data.pricePence,
      gatePositionPct: data.gatePositionPct,
    })
    articleId = result.articleId
  } catch (indexErr) {
    // Try to retract the relay event so the article doesn't become a dead link
    try {
      const retractEvent = new NDKEvent(ndk)
      retractEvent.kind = KIND_DELETION
      retractEvent.content = ''
      retractEvent.tags = [
        ['e', signedArticle.id!],
        ['a', `30023:${writerPubkey}:${dTag}`],
      ]
      const signedRetract = await signViaGateway(retractEvent)
      await signedRetract.publish()
    } catch { /* best-effort */ }
    throw indexErr
  }

  let vaultEventId: string | undefined

  // Step 4: If paywalled, encrypt the body and publish the vault event
  // Now we have the real article UUID from Step 3.
  if (data.isPaywalled && data.paywallContent) {
    vaultEventId = await publishVaultEvent({
      articleEventId: signedArticle.id,
      articleId,
      paywallBody: data.paywallContent,
      pricePence: data.pricePence,
      gatePositionPct: data.gatePositionPct,
      dTag,
      ndk,
    })

    // Step 5: Update the article index with the vault event ID
    // The articles endpoint uses ON CONFLICT to upsert, so re-posting
    // with the same nostrEventId updates the existing row.
    await articlesApi.index({
      nostrEventId: signedArticle.id,
      dTag,
      title: data.title,
      content: data.freeContent,
      isPaywalled: data.isPaywalled,
      pricePence: data.pricePence,
      gatePositionPct: data.gatePositionPct,
      vaultEventId,
    })
  }

  return {
    articleEventId: signedArticle.id,
    vaultEventId,
    dTag,
    articleId,
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

async function publishVaultEvent(params: {
  articleEventId: string
  articleId: string
  paywallBody: string
  pricePence: number
  gatePositionPct: number
  dTag: string
  ndk: NDK
}): Promise<string> {
  // Call the key service to encrypt the body — now with a real articleId UUID
  const res = await fetch(`${GATEWAY_URL}/api/v1/articles/${params.articleEventId}/vault`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      articleId: params.articleId,
      paywallBody: params.paywallBody,
      pricePence: params.pricePence,
      gatePositionPct: params.gatePositionPct,
      nostrDTag: params.dTag,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(`Vault creation failed: ${res.status} — ${body?.error ?? 'unknown'}`)
  }

  const { nostrVaultEvent } = await res.json()

  // Sign and publish the vault event
  const vaultEvent = new NDKEvent(params.ndk)
  vaultEvent.kind = nostrVaultEvent.kind
  vaultEvent.content = nostrVaultEvent.content
  vaultEvent.tags = nostrVaultEvent.tags

  const signedVault = await signViaGateway(vaultEvent)
  await signedVault.publish()

  // Report the vault event ID back to the key service
  await fetch(`${GATEWAY_URL}/api/v1/articles/${params.articleEventId}/vault`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultNostrEventId: signedVault.id }),
  })

  return signedVault.id
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
