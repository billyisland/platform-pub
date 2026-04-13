import { pool } from '../../shared/src/db/client.js'
import { signEvent } from '../lib/key-custody-client.js'
import { publishToRelay } from '../lib/nostr-publisher.js'
import { publishToPublication } from '../services/publication-publisher.js'
import { sendPublishNotifications } from '../../shared/src/lib/publish-emails.js'
import { checkAndTriggerDriveFulfilment } from '../routes/drives.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Scheduled Publishing Worker
//
// Polls for drafts whose scheduled_at has passed and publishes them.
// Runs every 60 seconds via advisory lock in gateway/index.ts.
//
// Publication articles use the existing publication-publisher pipeline.
// Personal articles are signed via key-custody and published to the relay.
// =============================================================================

const PAYWALL_GATE_MARKER = '<!-- paywall-gate -->'
const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL ?? 'http://localhost:3002'
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? ''

interface ScheduledDraft {
  id: string
  writer_id: string
  title: string
  content_raw: string
  nostr_d_tag: string | null
  gate_position_pct: number | null
  price_pence: number | null
  publication_id: string | null
}

export async function publishScheduledDrafts(): Promise<void> {
  // Fetch due drafts with row-level locking to prevent double-publish
  const { rows: drafts } = await pool.query<ScheduledDraft>(
    `SELECT id, writer_id, title, content_raw, nostr_d_tag,
            gate_position_pct, price_pence, publication_id
     FROM article_drafts
     WHERE scheduled_at IS NOT NULL AND scheduled_at <= now()
     ORDER BY scheduled_at ASC
     FOR UPDATE SKIP LOCKED`,
  )

  if (drafts.length === 0) return

  logger.info({ count: drafts.length }, 'Scheduler: processing due drafts')

  for (const draft of drafts) {
    try {
      if (draft.publication_id) {
        await publishPublicationDraft(draft)
      } else {
        await publishPersonalDraft(draft)
      }

      // Delete the draft on success
      await pool.query('DELETE FROM article_drafts WHERE id = $1', [draft.id])

      logger.info(
        { draftId: draft.id, writerId: draft.writer_id, title: draft.title },
        'Scheduler: draft published successfully',
      )
    } catch (err) {
      logger.error(
        { err, draftId: draft.id, writerId: draft.writer_id },
        'Scheduler: draft publish failed — will retry next cycle',
      )
    }
  }
}

// =============================================================================
// Publication articles — delegate to the existing server-side pipeline
// =============================================================================

async function publishPublicationDraft(draft: ScheduledDraft): Promise<void> {
  const { rows: authors } = await pool.query<{ nostr_pubkey: string }>(
    'SELECT nostr_pubkey FROM accounts WHERE id = $1',
    [draft.writer_id],
  )
  if (authors.length === 0) throw new Error(`Writer ${draft.writer_id} not found`)

  // Check if the author can publish to this publication
  const { rows: members } = await pool.query<{ can_publish: boolean }>(
    `SELECT can_publish FROM publication_members
     WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
    [draft.publication_id!, draft.writer_id],
  )
  const canPublish = members.length > 0 && members[0].can_publish

  const { freeContent, paywallContent, fullContent } = splitContent(draft.content_raw)
  const isPaywalled = !!paywallContent && (draft.price_pence ?? 0) > 0

  const result = await publishToPublication({
    publicationId: draft.publication_id!,
    authorId: draft.writer_id,
    authorPubkey: authors[0].nostr_pubkey,
    title: draft.title || 'Untitled',
    content: isPaywalled ? freeContent : fullContent,
    fullContent,
    accessMode: isPaywalled ? 'paywalled' : 'public',
    pricePence: isPaywalled ? draft.price_pence! : undefined,
    gatePositionPct: isPaywalled ? draft.gate_position_pct! : undefined,
    showOnWriterProfile: true,
    canPublish,
    existingDTag: draft.nostr_d_tag ?? undefined,
  })

  // Send notification emails for new articles
  if (result.status === 'published') {
    sendPublishNotifications(
      draft.writer_id, result.articleId, draft.title || 'Untitled',
      result.dTag, undefined, isPaywalled ? freeContent : fullContent,
    ).catch(err => logger.error({ err, draftId: draft.id }, 'Scheduler: publish email failed'))

    checkAndTriggerDriveFulfilment(draft.writer_id, result.articleId, draft.id).catch(err =>
      logger.error({ err, draftId: draft.id }, 'Scheduler: drive fulfilment check failed'),
    )
  }
}

// =============================================================================
// Personal articles — sign via key-custody and index in DB
// =============================================================================

async function publishPersonalDraft(draft: ScheduledDraft): Promise<void> {
  const { freeContent, paywallContent, fullContent } = splitContent(draft.content_raw)
  const isPaywalled = !!paywallContent && (draft.price_pence ?? 0) > 0

  const dTag = draft.nostr_d_tag ?? generateDTag(draft.title || 'untitled')
  const wordCount = fullContent.split(/\s+/).filter(Boolean).length

  // Build NIP-23 event (v1 — free content only for paywalled, full for free)
  const tags: string[][] = [
    ['d', dTag],
    ['title', draft.title || 'Untitled'],
    ['published_at', String(Math.floor(Date.now() / 1000))],
  ]

  if (isPaywalled) {
    tags.push(
      ['price', String(draft.price_pence), 'GBP'],
      ['gate', String(draft.gate_position_pct ?? 50)],
    )
  }

  const eventContent = isPaywalled ? freeContent : fullContent

  // Sign with the writer's custodial key
  const signed = await signEvent(draft.writer_id, {
    kind: 30023,
    content: eventContent,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  }, 'account')

  // Publish to relay
  await publishToRelay(signed as any)

  // Index in DB
  const slug = (draft.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120)

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO articles (
       writer_id, nostr_event_id, nostr_d_tag, title, slug,
       content_free, word_count, tier,
       access_mode, price_pence, gate_position_pct,
       published_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'tier1', $8, $9, $10, now())
     ON CONFLICT (writer_id, nostr_d_tag) WHERE deleted_at IS NULL DO UPDATE SET
       nostr_event_id = EXCLUDED.nostr_event_id,
       title = EXCLUDED.title,
       slug = EXCLUDED.slug,
       content_free = EXCLUDED.content_free,
       word_count = EXCLUDED.word_count,
       access_mode = EXCLUDED.access_mode,
       price_pence = EXCLUDED.price_pence,
       gate_position_pct = EXCLUDED.gate_position_pct,
       published_at = now()
     RETURNING id`,
    [
      draft.writer_id,
      signed.id,
      dTag,
      draft.title || 'Untitled',
      slug,
      eventContent,
      wordCount,
      isPaywalled ? 'paywalled' : 'public',
      isPaywalled ? draft.price_pence : null,
      isPaywalled ? (draft.gate_position_pct ?? null) : null,
    ],
  )

  const articleId = rows[0].id

  // For paywalled articles: encrypt paywall body and re-publish with payload tag
  if (isPaywalled && paywallContent) {
    try {
      const vault = await createVault(signed.id, articleId, dTag, draft, paywallContent)

      // Build v2 with payload tag
      const v2Tags = [...tags, ['payload', vault.ciphertext, vault.algorithm]]
      const v2 = await signEvent(draft.writer_id, {
        kind: 30023,
        content: freeContent,
        tags: v2Tags,
        created_at: (signed as any).created_at + 1,
      }, 'account')

      await publishToRelay(v2 as any)

      // Re-index with v2 event ID
      await pool.query(
        'UPDATE articles SET nostr_event_id = $1 WHERE id = $2',
        [v2.id, articleId],
      )
    } catch (err) {
      // v1 is already published and indexed — paywall encryption failed but
      // the article is live as free content. Log and continue.
      logger.error(
        { err, draftId: draft.id, articleId },
        'Scheduler: vault encryption failed — article published without paywall',
      )
    }
  }

  // Send notification emails
  sendPublishNotifications(
    draft.writer_id, articleId, draft.title || 'Untitled',
    dTag, undefined, eventContent,
  ).catch(err => logger.error({ err, draftId: draft.id }, 'Scheduler: publish email failed'))

  // Check drive fulfilment
  checkAndTriggerDriveFulfilment(draft.writer_id, articleId, draft.id).catch(err =>
    logger.error({ err, draftId: draft.id }, 'Scheduler: drive fulfilment check failed'),
  )
}

// =============================================================================
// Helpers
// =============================================================================

function splitContent(raw: string): { freeContent: string; paywallContent: string; fullContent: string } {
  const fullContent = raw.replace(PAYWALL_GATE_MARKER, '').trim()
  const markerIndex = raw.indexOf(PAYWALL_GATE_MARKER)

  if (markerIndex === -1) {
    return { freeContent: raw.trim(), paywallContent: '', fullContent }
  }

  return {
    freeContent: raw.slice(0, markerIndex).trim(),
    paywallContent: raw.slice(markerIndex + PAYWALL_GATE_MARKER.length).trim(),
    fullContent,
  }
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

async function createVault(
  nostrEventId: string,
  articleId: string,
  dTag: string,
  draft: ScheduledDraft,
  paywallBody: string,
): Promise<{ ciphertext: string; algorithm: string }> {
  const res = await fetch(`${KEY_SERVICE_URL}/api/v1/articles/${nostrEventId}/vault`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-writer-id': draft.writer_id,
      'X-Internal-Secret': process.env.INTERNAL_SECRET ?? '',
    },
    body: JSON.stringify({
      articleId,
      paywallBody,
      pricePence: draft.price_pence,
      gatePositionPct: draft.gate_position_pct,
      nostrDTag: dTag,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`Vault creation failed: ${res.status} — ${JSON.stringify(body)}`)
  }

  return res.json() as Promise<{ ciphertext: string; algorithm: string }>
}
