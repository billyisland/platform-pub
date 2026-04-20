import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { signEvent } from '../lib/key-custody-client.js'
import { publishToRelay } from '../lib/nostr-publisher.js'
import { publishToPublication } from '../services/publication-publisher.js'
import { sendPublishNotifications } from '@platform-pub/shared/lib/publish-emails.js'
import { checkAndTriggerDriveFulfilment } from '../routes/drives.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { slugify, generateDTag } from '@platform-pub/shared/lib/slug.js'
import { truncatePreview } from '@platform-pub/shared/lib/text.js'

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
  const slug = slugify(draft.title || 'untitled', 120)

  const baseTags: string[][] = [
    ['d', dTag],
    ['title', draft.title || 'Untitled'],
    ['published_at', String(Math.floor(Date.now() / 1000))],
  ]

  if (isPaywalled) {
    baseTags.push(
      ['price', String(draft.price_pence), 'GBP'],
      ['gate', String(draft.gate_position_pct ?? 50)],
    )
  }

  const eventContent = isPaywalled ? freeContent : fullContent

  // Sign v1. For free articles this is the canonical event. For paywalled
  // articles v1 is a template used only to mint an event id that the key
  // service accepts as the ownership-check target — v1 is never published,
  // because a paywalled event without a payload tag is a broken reader state.
  const v1 = await signEvent(draft.writer_id, {
    kind: 30023,
    content: eventContent,
    tags: baseTags,
    created_at: Math.floor(Date.now() / 1000),
  }, 'account')

  // Upsert the articles row + dual-write to feed_items so vault creation —
  // which checks the writer owns a row with this nostr_event_id — has
  // something to match against, and the feed has a matching row for the
  // unified timeline. If any subsequent step throws, the outer catch
  // retains the draft for retry; both upserts are idempotent and retries
  // converge via the key service's re-publish path (which reuses the
  // existing content key).
  const articleId = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
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
        v1.id,
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
    const artId = rows[0].id

    const { rows: [author] } = await client.query<{ display_name: string | null; avatar_blossom_url: string | null; username: string | null }>(
      `SELECT display_name, avatar_blossom_url, username FROM accounts WHERE id = $1`,
      [draft.writer_id]
    )
    await client.query(`
      INSERT INTO feed_items (
        item_type, article_id, author_id,
        author_name, author_avatar, author_username,
        title, content_preview, nostr_event_id,
        tier, published_at
      ) VALUES (
        'article', $1, $2,
        $3, $4, $5,
        $6, $7, $8,
        'tier1', now()
      )
      ON CONFLICT (article_id) WHERE article_id IS NOT NULL DO UPDATE SET
        title = EXCLUDED.title,
        content_preview = EXCLUDED.content_preview,
        nostr_event_id = EXCLUDED.nostr_event_id,
        author_name = EXCLUDED.author_name,
        author_avatar = EXCLUDED.author_avatar
    `, [
      artId, draft.writer_id,
      author?.display_name ?? author?.username ?? 'Unknown',
      author?.avatar_blossom_url ?? null,
      author?.username ?? null,
      draft.title || 'Untitled',
      truncatePreview(eventContent),
      v1.id,
    ])

    return artId
  })

  if (isPaywalled && paywallContent) {
    // Build the canonical v2 (with payload tag) and publish that. v1 is
    // discarded — it was only needed to mint an event id the key service
    // would accept for the ownership check.
    const vault = await createVault(v1.id, articleId, dTag, draft, paywallContent)

    const v2 = await signEvent(draft.writer_id, {
      kind: 30023,
      content: freeContent,
      tags: [...baseTags, ['payload', vault.ciphertext, vault.algorithm]],
      created_at: (v1 as any).created_at + 1,
    }, 'account')

    await publishToRelay(v2 as any)

    await withTransaction(async (client) => {
      await client.query(
        'UPDATE articles SET nostr_event_id = $1 WHERE id = $2',
        [v2.id, articleId],
      )
      await client.query(
        'UPDATE feed_items SET nostr_event_id = $1 WHERE article_id = $2',
        [v2.id, articleId],
      )
    })
  } else {
    await publishToRelay(v1 as any)
  }

  sendPublishNotifications(
    draft.writer_id, articleId, draft.title || 'Untitled',
    dTag, undefined, eventContent,
  ).catch(err => logger.error({ err, draftId: draft.id }, 'Scheduler: publish email failed'))

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
