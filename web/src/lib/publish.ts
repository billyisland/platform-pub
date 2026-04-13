import { KIND_ARTICLE, KIND_DELETION } from './ndk'
import { signAndPublish, signViaGateway } from './sign'
import { articles as articlesApi, publications as publicationsApi } from './api'
import type { PublishData } from '../components/editor/ArticleEditor'

// =============================================================================
// Publishing Service
//
// Orchestrates the full article publishing pipeline:
//
//   1. Build and sign the NIP-23 article event v1 (free content only)
//   2. Publish v1 to the relay via gateway
//   3. Index v1 in the platform database → get back the article UUID
//   4. If paywalled:
//      a. Call key service to encrypt the paywall body (needs real article UUID)
//      b. Build NIP-23 event v2 with ['payload', ciphertext, algorithm] tag
//      c. Sign and publish v2 via gateway
//      d. Re-index with v2 event ID
// =============================================================================

// Use relative URLs so requests go through the Next.js rewrite (same origin).
const API_BASE = '/api/v1'

interface PublishResult {
  articleEventId: string
  dTag: string
  articleId: string
}

export async function publishArticle(
  data: PublishData,
  writerPubkey: string,
  existingDTag?: string
): Promise<PublishResult> {
  const dTag = existingDTag ?? generateDTag(data.title)

  // Step 1: Build and publish NIP-23 v1 (free content only — no payload yet)
  const v1 = buildNip23Event(data, dTag, null)
  const signedV1 = await signAndPublish(v1)

  // Step 2: Index v1 → get article UUID
  let articleId!: string
  try {
    const result = await articlesApi.index({
      nostrEventId: signedV1.id,
      dTag,
      title: data.title,
      summary: data.dek?.trim() || undefined,
      content: data.freeContent,
      accessMode: data.isPaywalled ? 'paywalled' : 'public',
      pricePence: data.pricePence,
      gatePositionPct: data.gatePositionPct,
      sendEmail: data.sendEmail,
    })
    articleId = result.articleId
  } catch (indexErr) {
    // Retract v1 from relay so it doesn't become a dead link
    try {
      await signAndPublish({
        kind: KIND_DELETION,
        content: '',
        tags: [
          ['e', signedV1.id!],
          ['a', `30023:${writerPubkey}:${dTag}`],
        ],
      })
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
  // Replaceable events (kind 30023) require strictly newer created_at to replace
  // the prior version on the relay. Pin v2 one second ahead of v1.
  const v2 = buildNip23Event(data, dTag, { ciphertext, algorithm })
  const signedV2 = await signAndPublish({ ...v2, created_at: signedV1.created_at + 1 })

  // Step 5: Re-index with v2 event ID (upsert on nostr_event_id)
  await articlesApi.index({
    nostrEventId: signedV2.id,
    dTag,
    title: data.title,
    summary: data.dek?.trim() || undefined,
    content: data.freeContent,
    accessMode: data.isPaywalled ? 'paywalled' : 'public',
    pricePence: data.pricePence,
    gatePositionPct: data.gatePositionPct,
  })

  return { articleEventId: signedV2.id, dTag, articleId }
}

// =============================================================================
// Internal helpers
// =============================================================================

function buildNip23Event(
  data: PublishData,
  dTag: string,
  payload: { ciphertext: string; algorithm: string } | null
) {
  const tags: string[][] = [
    ['d', dTag],
    ['title', data.title],
    ['published_at', String(Math.floor(Date.now() / 1000))],
  ]

  if (data.dek?.trim()) {
    tags.push(['summary', data.dek.trim()])
  }

  if (data.isPaywalled) {
    tags.push(
      ['price', String(data.pricePence), 'GBP'],
      ['gate', String(data.gatePositionPct)]
    )
  }

  if (payload) {
    tags.push(['payload', payload.ciphertext, payload.algorithm])
  }

  return {
    kind: KIND_ARTICLE,
    content: data.isPaywalled ? data.freeContent : data.content,
    tags,
  }
}

async function encryptPaywallBody(
  articleEventId: string,
  articleId: string,
  dTag: string,
  data: PublishData
): Promise<{ ciphertext: string; algorithm: string }> {
  const res = await fetch(`${API_BASE}/articles/${articleEventId}/vault`, {
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

// =============================================================================
// Publication publishing — delegates to the server-side pipeline
// =============================================================================

export async function publishToPublication(
  publicationId: string,
  data: PublishData & { showOnWriterProfile: boolean },
  existingDTag?: string
): Promise<{ articleId: string; status: string; dTag: string }> {
  return publicationsApi.submitArticle(publicationId, {
    title: data.title,
    summary: data.dek?.trim() || undefined,
    content: data.isPaywalled ? data.freeContent : data.content,
    fullContent: data.content,
    accessMode: data.isPaywalled ? 'paywalled' : 'public',
    pricePence: data.isPaywalled ? data.pricePence : undefined,
    gatePositionPct: data.isPaywalled ? data.gatePositionPct : undefined,
    showOnWriterProfile: data.showOnWriterProfile,
    existingDTag,
  })
}

export function generateDTag(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)

  const timestamp = Math.floor(Date.now() / 1000).toString(36)
  return `${slug}-${timestamp}`
}
