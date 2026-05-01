import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Workspace feeds (slices 3 + 4)
//
// GET    /feeds                       — list feeds owned by the caller
// POST   /feeds                       — create { name }
// PATCH  /feeds/:id                   — rename { name }
// DELETE /feeds/:id                   — delete (cascade removes feed_sources)
// GET    /feeds/:id/items             — feed contents
// GET    /feeds/:id/sources           — list source rows (slice 4)
// POST   /feeds/:id/sources           — add a source (slice 4)
// DELETE /feeds/:id/sources/:sid      — remove a source (slice 4)
//
// Slice 3 shipped schema + CRUD + an empty-sources placeholder for /items:
// when a feed has no feed_sources rows the route falls back to the caller's
// explore stream. Slice 4 wires source authoring + makes /items honour rows.
// Weight + sampling_mode are still ignored — the ranking story comes later.
//
// Authz: feeds are private to the owner. Every read and write asserts
// ownership before touching the row. There is no public-feed concept on this
// branch yet.
// =============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const createFeedSchema = z.object({
  name: z.string().trim().min(1).max(80),
})

const patchFeedSchema = z.object({
  name: z.string().trim().min(1).max(80),
})

// POST /feeds/:id/sources — native targets pass an existing UUID, external
// accepts either an existing externalSourceId or a (protocol, sourceUri) pair
// which is upserted, tag passes a name.
//
// Originally a z.discriminatedUnion('sourceType', [...]), but Zod 3.25+
// rejects duplicate discriminator values at schema-construction time and
// our two external_source variants share that value. Plain z.union tries
// each variant in order; the two external_source shapes are disjoint by
// required fields (externalSourceId vs. protocol + sourceUri) so there is
// no ambiguity, and the route handler branches on `'externalSourceId' in
// input` rather than a tagged sub-discriminator. Validation messages are
// slightly less surgical than a discriminated union but the wire shape is
// unchanged.
const addSourceSchema = z.union([
  z.object({
    sourceType: z.literal('account'),
    accountId: z.string().uuid(),
  }),
  z.object({
    sourceType: z.literal('publication'),
    publicationId: z.string().uuid(),
  }),
  z.object({
    sourceType: z.literal('tag'),
    tagName: z.string().trim().min(1).max(64),
  }),
  z.object({
    sourceType: z.literal('external_source'),
    externalSourceId: z.string().uuid(),
  }),
  z.object({
    sourceType: z.literal('external_source'),
    protocol: z.enum(['rss', 'atproto', 'activitypub', 'nostr_external']),
    sourceUri: z.string().min(1).max(2048),
    displayName: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    avatarUrl: z.string().max(2048).optional(),
    relayUrls: z.array(z.string().min(1).max(2048)).max(10).optional(),
  }),
])
type AddSourceInput = z.infer<typeof addSourceSchema>

interface FeedRow {
  id: string
  name: string
  created_at: Date
  updated_at: Date
  source_count: number
}

function feedRowToResponse(row: FeedRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sourceCount: Number(row.source_count),
  }
}

async function loadFeed(feedId: string, ownerId: string): Promise<FeedRow | null> {
  const { rows } = await pool.query<FeedRow>(
    `SELECT f.id, f.name, f.created_at, f.updated_at,
       (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count
     FROM feeds f
     WHERE f.id = $1 AND f.owner_id = $2`,
    [feedId, ownerId],
  )
  return rows[0] ?? null
}

export async function feedsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /feeds — list mine, newest first
  // ---------------------------------------------------------------------------
  app.get('/feeds', { preHandler: requireAuth }, async (req, reply) => {
    const ownerId = req.session!.sub!
    const { rows } = await pool.query<FeedRow>(
      `SELECT f.id, f.name, f.created_at, f.updated_at,
         (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count
       FROM feeds f
       WHERE f.owner_id = $1
       ORDER BY f.created_at ASC, f.id ASC`,
      [ownerId],
    )
    return reply.send({ feeds: rows.map(feedRowToResponse) })
  })

  // ---------------------------------------------------------------------------
  // POST /feeds — create
  // ---------------------------------------------------------------------------
  app.post<{ Body: unknown }>('/feeds', { preHandler: requireAuth }, async (req, reply) => {
    const ownerId = req.session!.sub!
    const parsed = createFeedSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', details: parsed.error.flatten() })
    }
    const { rows } = await pool.query<FeedRow>(
      `INSERT INTO feeds (owner_id, name) VALUES ($1, $2)
       RETURNING id, name, created_at, updated_at, 0::int AS source_count`,
      [ownerId, parsed.data.name],
    )
    return reply.status(201).send({ feed: feedRowToResponse(rows[0]) })
  })

  // ---------------------------------------------------------------------------
  // PATCH /feeds/:id — rename
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/feeds/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub!
      const { id } = req.params
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Invalid feed id' })

      const parsed = patchFeedSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parsed.error.flatten() })
      }

      const { rows } = await pool.query<FeedRow>(
        `UPDATE feeds SET name = $1
         WHERE id = $2 AND owner_id = $3
         RETURNING id, name, created_at, updated_at,
           (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = feeds.id) AS source_count`,
        [parsed.data.name, id, ownerId],
      )
      if (rows.length === 0) return reply.status(404).send({ error: 'Feed not found' })
      return reply.send({ feed: feedRowToResponse(rows[0]) })
    },
  )

  // ---------------------------------------------------------------------------
  // DELETE /feeds/:id
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/feeds/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub!
      const { id } = req.params
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Invalid feed id' })

      const { rowCount } = await pool.query(
        `DELETE FROM feeds WHERE id = $1 AND owner_id = $2`,
        [id, ownerId],
      )
      if (rowCount === 0) return reply.status(404).send({ error: 'Feed not found' })
      return reply.status(204).send()
    },
  )

  // ---------------------------------------------------------------------------
  // GET /feeds/:id/items — feed contents
  //
  // Empty source set → falls back to the caller's explore feed. This keeps
  // the vessel meaningful while source-set wiring is still pending; once
  // sources arrive the SELECT branches on feed_sources rows.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/feeds/:id/items',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub!
      const { id } = req.params
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Invalid feed id' })

      const feed = await loadFeed(id, ownerId)
      if (!feed) return reply.status(404).send({ error: 'Feed not found' })

      try {
        const limit = Math.min(parseInt(req.query.limit ?? '20', 10) || 20, 50)

        if (feed.source_count === 0) {
          // Placeholder: an empty source set surfaces the platform's explore
          // stream so the vessel is useful out of the box. Once the composer
          // adds the first source this branch is no longer reached for that
          // feed.
          const { items, nextCursor } = await placeholderExploreItems(
            ownerId,
            req.query.cursor,
            limit,
          )
          return reply.send({
            feed: feedRowToResponse(feed),
            items,
            nextCursor,
            placeholder: true,
          })
        }

        const { items, nextCursor } = await sourceFilteredItems(
          ownerId,
          id,
          req.query.cursor,
          limit,
        )
        return reply.send({
          feed: feedRowToResponse(feed),
          items,
          nextCursor,
          placeholder: false,
        })
      } catch (err) {
        logger.error({ err, feedId: id }, 'Feed items fetch failed')
        return reply.status(500).send({ error: 'Feed items fetch failed' })
      }
    },
  )

  // ---------------------------------------------------------------------------
  // GET /feeds/:id/sources — list rows with target display info
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/feeds/:id/sources',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub!
      const { id } = req.params
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Invalid feed id' })

      const feed = await loadFeed(id, ownerId)
      if (!feed) return reply.status(404).send({ error: 'Feed not found' })

      // LEFT JOINs against each potential target type. Exactly one is non-null
      // per row (CHECK in migration 077), so COALESCE picks the populated
      // display fields without ambiguity.
      const { rows } = await pool.query(
        `SELECT fs.id, fs.source_type, fs.weight, fs.sampling_mode, fs.muted_at, fs.created_at,
           fs.account_id, fs.publication_id, fs.external_source_id, fs.tag_name,
           acc.username AS account_username, acc.display_name AS account_display_name, acc.avatar_blossom_url AS account_avatar,
           pub.slug AS publication_slug, pub.name AS publication_name, pub.logo_blossom_url AS publication_avatar,
           xs.protocol AS external_protocol, xs.source_uri AS external_source_uri,
           xs.display_name AS external_display_name, xs.avatar_url AS external_avatar
         FROM feed_sources fs
         LEFT JOIN accounts acc ON acc.id = fs.account_id
         LEFT JOIN publications pub ON pub.id = fs.publication_id
         LEFT JOIN external_sources xs ON xs.id = fs.external_source_id
         WHERE fs.feed_id = $1
         ORDER BY fs.created_at ASC, fs.id ASC`,
        [id],
      )
      return reply.send({ sources: rows.map(sourceRowToResponse) })
    },
  )

  // ---------------------------------------------------------------------------
  // POST /feeds/:id/sources — add a source
  //
  // The body is a discriminated union on sourceType. Native targets pass an
  // existing UUID; tag passes a name (created on the fly if new); external
  // accepts either an existing externalSourceId OR a (protocol, sourceUri)
  // pair which is upserted into external_sources and gets a subscription
  // ensured for the caller (so the existing fetch-job machinery picks it up).
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/feeds/:id/sources',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub!
      const { id } = req.params
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Invalid feed id' })

      const feed = await loadFeed(id, ownerId)
      if (!feed) return reply.status(404).send({ error: 'Feed not found' })

      const parsed = addSourceSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parsed.error.flatten() })
      }

      try {
        const result = await addSource(id, ownerId, parsed.data)
        return reply.status(201).send({ source: result.source, ensured: result.ensured })
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'TARGET_NOT_FOUND') {
          return reply.status(404).send({ error: 'Source target not found' })
        }
        if ((err as { code?: string } | null)?.code === 'DUPLICATE') {
          return reply.status(409).send({ error: 'Source already on feed' })
        }
        logger.error({ err, feedId: id }, 'Add source failed')
        return reply.status(500).send({ error: 'Add source failed' })
      }
    },
  )

  // ---------------------------------------------------------------------------
  // DELETE /feeds/:id/sources/:sourceId — remove a source
  //
  // The associated external_subscriptions row (if any) is deliberately not
  // touched: a user may keep the subscription via /subscriptions or use it
  // in another feed. Subscription teardown is its own gesture.
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string; sourceId: string } }>(
    '/feeds/:id/sources/:sourceId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub!
      const { id, sourceId } = req.params
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'Invalid feed id' })
      if (!UUID_RE.test(sourceId)) return reply.status(400).send({ error: 'Invalid source id' })

      const feed = await loadFeed(id, ownerId)
      if (!feed) return reply.status(404).send({ error: 'Feed not found' })

      const { rowCount } = await pool.query(
        `DELETE FROM feed_sources WHERE id = $1 AND feed_id = $2`,
        [sourceId, id],
      )
      if (rowCount === 0) return reply.status(404).send({ error: 'Source not found' })
      return reply.status(204).send()
    },
  )
}

// -----------------------------------------------------------------------------
// Placeholder items query — mirrors timeline.ts explore for an empty-sources
// feed. Lifted inline rather than imported because timeline.ts's helpers are
// module-private; this is a deliberate tiny duplication that retires when
// source-set semantics arrive.
// -----------------------------------------------------------------------------

const FEED_SELECT = `
  fi.id AS fi_id, fi.item_type, fi.article_id, fi.note_id, fi.external_item_id,
  fi.author_id, fi.nostr_event_id, fi.source_protocol, fi.source_item_uri,
  fi.source_id, fi.media, fi.score, fi.tier,
  EXTRACT(EPOCH FROM fi.published_at)::bigint AS published_at_epoch,
  acc.nostr_pubkey AS nostr_pubkey,
  a.nostr_d_tag, a.access_mode, a.price_pence, a.gate_position_pct,
  a.content_free, a.summary AS a_summary, a.size_tier,
  COALESCE(
    (SELECT array_agg(t.name ORDER BY t.name)
     FROM article_tags at2 JOIN tags t ON t.id = at2.tag_id
     WHERE at2.article_id = a.id),
    '{}'
  ) AS tag_names,
  n.content AS note_content, n.is_quote_comment,
  n.quoted_event_id, n.quoted_event_kind,
  n.quoted_excerpt, n.quoted_title, n.quoted_author,
  ei.author_name AS ei_author_name, ei.author_handle AS ei_author_handle,
  ei.author_avatar_url AS ei_author_avatar_url, ei.author_uri AS ei_author_uri,
  ei.content_text AS ei_content_text, ei.content_html AS ei_content_html,
  ei.title AS ei_title, ei.summary AS ei_summary,
  ei.source_reply_uri AS ei_source_reply_uri,
  ei.source_quote_uri AS ei_source_quote_uri,
  xs.display_name AS source_display_name, xs.avatar_url AS source_avatar_url,
  tl.pip_status
`

const FEED_JOINS = `
  LEFT JOIN articles a ON a.id = fi.article_id
  LEFT JOIN notes n ON n.id = fi.note_id
  LEFT JOIN accounts acc ON acc.id = fi.author_id
  LEFT JOIN external_items ei ON ei.id = fi.external_item_id
  LEFT JOIN external_sources xs ON xs.id = fi.source_id
  LEFT JOIN trust_layer1 tl ON tl.user_id = fi.author_id
`

interface CursorParts {
  score?: number
  ts: number
  id: string
}

const UNBOUNDED_SCORE = 1e18

function parseCursor(raw: string | undefined): CursorParts | undefined {
  if (!raw) return undefined
  const parts = raw.split(':')
  if (parts.length === 3) {
    const score = Number(parts[0])
    const ts = parseInt(parts[1], 10)
    const id = parts[2]
    if (!isNaN(score) && !isNaN(ts) && UUID_RE.test(id)) return { score, ts, id }
  }
  if (parts.length === 2) {
    const ts = parseInt(parts[0], 10)
    const id = parts[1]
    if (!isNaN(ts) && UUID_RE.test(id)) return { ts, id }
  }
  return undefined
}

function rowToItem(row: any) {
  if (row.item_type === 'article') {
    return {
      type: 'article' as const,
      nostrEventId: row.nostr_event_id,
      pubkey: row.nostr_pubkey,
      dTag: row.nostr_d_tag,
      title: row.title,
      summary: row.a_summary ?? '',
      contentFree: row.content_free ?? '',
      accessMode: row.access_mode,
      isPaywalled: row.access_mode === 'paywalled',
      pricePence: row.price_pence ?? undefined,
      gatePositionPct: row.gate_position_pct ?? undefined,
      publishedAt: Number(row.published_at_epoch),
      score: row.score != null ? Number(row.score) : undefined,
      tags: row.tag_names ?? [],
      sizeTier: row.size_tier ?? 'standard',
      pipStatus: row.pip_status ?? 'unknown',
    }
  }
  if (row.item_type === 'note') {
    return {
      type: 'note' as const,
      nostrEventId: row.nostr_event_id,
      pubkey: row.nostr_pubkey,
      content: row.note_content,
      isQuoteComment: row.is_quote_comment,
      quotedEventId: row.quoted_event_id ?? undefined,
      quotedEventKind: row.quoted_event_kind ?? undefined,
      quotedExcerpt: row.quoted_excerpt ?? undefined,
      quotedTitle: row.quoted_title ?? undefined,
      quotedAuthor: row.quoted_author ?? undefined,
      publishedAt: Number(row.published_at_epoch),
      score: row.score != null ? Number(row.score) : undefined,
      pipStatus: row.pip_status ?? 'unknown',
    }
  }
  return {
    type: 'external' as const,
    id: row.external_item_id,
    sourceProtocol: row.source_protocol,
    sourceItemUri: row.source_item_uri,
    authorName: row.ei_author_name,
    authorHandle: row.ei_author_handle,
    authorAvatarUrl: row.ei_author_avatar_url,
    authorUri: row.ei_author_uri,
    contentText: row.ei_content_text,
    contentHtml: row.ei_content_html,
    title: row.ei_title,
    summary: row.ei_summary,
    sourceReplyUri: row.ei_source_reply_uri,
    sourceQuoteUri: row.ei_source_quote_uri,
    media: row.media,
    publishedAt: Number(row.published_at_epoch),
    sourceName: row.source_display_name,
    sourceAvatar: row.source_avatar_url,
    pipStatus: 'unknown' as const,
  }
}

interface SourceRow {
  id: string
  source_type: 'account' | 'publication' | 'external_source' | 'tag'
  weight: string
  sampling_mode: string
  muted_at: Date | null
  created_at: Date
  account_id: string | null
  publication_id: string | null
  external_source_id: string | null
  tag_name: string | null
  account_username: string | null
  account_display_name: string | null
  account_avatar: string | null
  publication_slug: string | null
  publication_name: string | null
  publication_avatar: string | null
  external_protocol: string | null
  external_source_uri: string | null
  external_display_name: string | null
  external_avatar: string | null
}

function sourceRowToResponse(row: SourceRow) {
  // The display block is what the UI renders in the source list. Each branch
  // returns a small, self-describing object so the client doesn't have to
  // re-derive labels from foreign keys.
  let display: Record<string, string | null> = {}
  if (row.source_type === 'account') {
    display = {
      kind: 'account',
      label: row.account_display_name ?? row.account_username ?? '(deleted account)',
      sublabel: row.account_username ? `@${row.account_username}` : null,
      avatar: row.account_avatar,
    }
  } else if (row.source_type === 'publication') {
    display = {
      kind: 'publication',
      label: row.publication_name ?? row.publication_slug ?? '(deleted publication)',
      sublabel: row.publication_slug ? `/pub/${row.publication_slug}` : null,
      avatar: row.publication_avatar,
    }
  } else if (row.source_type === 'external_source') {
    display = {
      kind: 'external_source',
      label: row.external_display_name ?? row.external_source_uri ?? '(deleted source)',
      sublabel: row.external_protocol,
      avatar: row.external_avatar,
    }
  } else {
    display = {
      kind: 'tag',
      label: `#${row.tag_name}`,
      sublabel: null,
      avatar: null,
    }
  }
  return {
    id: row.id,
    sourceType: row.source_type,
    weight: Number(row.weight),
    samplingMode: row.sampling_mode,
    mutedAt: row.muted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    display,
  }
}

async function addSource(feedId: string, ownerId: string, input: AddSourceInput) {
  // Per source_type, validate the target exists and bind the polymorphic FK.
  // For external_source with a (protocol, sourceUri) pair we additionally
  // upsert the external_sources row and ensure the caller has a subscription
  // — without one, the feed-ingest workers wouldn't poll the source.
  if (input.sourceType === 'account') {
    const { rows } = await pool.query(`SELECT id FROM accounts WHERE id = $1`, [input.accountId])
    if (rows.length === 0) throw tagged('TARGET_NOT_FOUND')
    const inserted = await insertSource(feedId, 'account', { account_id: input.accountId })
    return { source: inserted, ensured: null }
  }

  if (input.sourceType === 'publication') {
    const { rows } = await pool.query(`SELECT id FROM publications WHERE id = $1`, [input.publicationId])
    if (rows.length === 0) throw tagged('TARGET_NOT_FOUND')
    const inserted = await insertSource(feedId, 'publication', { publication_id: input.publicationId })
    return { source: inserted, ensured: null }
  }

  if (input.sourceType === 'tag') {
    // Tags are looser than UUID targets — feed_sources stores the name
    // verbatim, so a tag can be added before any article carries it. Mirror
    // it into the tags table so /tag/:name pages and global tag listings
    // behave consistently.
    await pool.query(
      `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [input.tagName],
    )
    const inserted = await insertSource(feedId, 'tag', { tag_name: input.tagName })
    return { source: inserted, ensured: null }
  }

  // external_source — two shapes
  if ('externalSourceId' in input) {
    const { rows } = await pool.query(`SELECT id FROM external_sources WHERE id = $1`, [
      input.externalSourceId,
    ])
    if (rows.length === 0) throw tagged('TARGET_NOT_FOUND')
    const inserted = await insertSource(feedId, 'external_source', {
      external_source_id: input.externalSourceId,
    })
    return { source: inserted, ensured: null }
  }

  // (protocol, sourceUri) — upsert source + ensure subscription + insert row
  const { protocol, sourceUri, displayName, description, avatarUrl, relayUrls } = input

  if (protocol === 'rss') {
    try {
      const u = new URL(sourceUri)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw tagged('TARGET_NOT_FOUND')
    } catch { throw tagged('TARGET_NOT_FOUND') }
  } else if (protocol === 'activitypub') {
    try {
      const u = new URL(sourceUri)
      if (u.protocol !== 'https:') throw tagged('TARGET_NOT_FOUND')
    } catch { throw tagged('TARGET_NOT_FOUND') }
  } else if (protocol === 'atproto') {
    if (!/^did:(plc|web):[a-zA-Z0-9.:_-]+$/.test(sourceUri)) throw tagged('TARGET_NOT_FOUND')
  } else if (protocol === 'nostr_external') {
    if (!/^[0-9a-f]{64}$/i.test(sourceUri)) throw tagged('TARGET_NOT_FOUND')
  }

  const { externalSourceId, subscriptionId } = await withTransaction(async (client) => {
    const { rows: [src] } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name, description, avatar_url, relay_urls)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (protocol, source_uri) DO UPDATE SET
         display_name = COALESCE(NULLIF($3, ''), external_sources.display_name),
         description  = COALESCE(NULLIF($4, ''), external_sources.description),
         avatar_url   = COALESCE(NULLIF($5, ''), external_sources.avatar_url),
         relay_urls   = COALESCE($6, external_sources.relay_urls),
         is_active = TRUE,
         orphaned_at = NULL,
         updated_at = now()
       RETURNING id`,
      [
        protocol,
        sourceUri,
        displayName ?? null,
        description ?? null,
        avatarUrl ?? null,
        protocol === 'nostr_external' && relayUrls && relayUrls.length > 0 ? relayUrls : null,
      ],
    )
    const { rows: [sub] } = await client.query<{ id: string }>(
      `INSERT INTO external_subscriptions (subscriber_id, source_id)
       VALUES ($1, $2)
       ON CONFLICT (subscriber_id, source_id) DO UPDATE SET is_muted = FALSE
       RETURNING id`,
      [ownerId, src.id],
    )
    return { externalSourceId: src.id, subscriptionId: sub.id }
  })

  // Kick off an immediate fetch so the new source has content to show
  // shortly after the user adds it (atproto goes via Jetstream's 60s DID
  // refresh — no per-add job).
  const fetchTask = protocol === 'rss'
    ? 'feed_ingest_rss'
    : protocol === 'nostr_external'
      ? 'feed_ingest_nostr'
      : protocol === 'activitypub'
        ? 'feed_ingest_activitypub'
        : null
  if (fetchTask) {
    await pool.query(
      `SELECT graphile_worker.add_job(
         $2,
         json_build_object('sourceId', $1::text),
         job_key := 'feed_ingest_' || $1::text,
         max_attempts := 1
       )`,
      [externalSourceId, fetchTask],
    )
  }

  const inserted = await insertSource(feedId, 'external_source', {
    external_source_id: externalSourceId,
  })
  return { source: inserted, ensured: { externalSourceId, subscriptionId } }
}

async function insertSource(
  feedId: string,
  sourceType: 'account' | 'publication' | 'external_source' | 'tag',
  target: {
    account_id?: string
    publication_id?: string
    external_source_id?: string
    tag_name?: string
  },
) {
  try {
    const { rows } = await pool.query<SourceRow>(
      `INSERT INTO feed_sources (feed_id, source_type, account_id, publication_id, external_source_id, tag_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, source_type, weight, sampling_mode, muted_at, created_at,
                 account_id, publication_id, external_source_id, tag_name,
                 NULL::text AS account_username, NULL::text AS account_display_name, NULL::text AS account_avatar,
                 NULL::text AS publication_slug, NULL::text AS publication_name, NULL::text AS publication_avatar,
                 NULL::text AS external_protocol, NULL::text AS external_source_uri,
                 NULL::text AS external_display_name, NULL::text AS external_avatar`,
      [
        feedId,
        sourceType,
        target.account_id ?? null,
        target.publication_id ?? null,
        target.external_source_id ?? null,
        target.tag_name ?? null,
      ],
    )
    // The display fields above are NULLs from the bare INSERT — re-hydrate
    // by fetching the row through the same join the GET endpoint uses, so
    // the client sees the same shape on create as on list.
    const { rows: hydrated } = await pool.query<SourceRow>(
      `SELECT fs.id, fs.source_type, fs.weight, fs.sampling_mode, fs.muted_at, fs.created_at,
         fs.account_id, fs.publication_id, fs.external_source_id, fs.tag_name,
         acc.username AS account_username, acc.display_name AS account_display_name, acc.avatar_blossom_url AS account_avatar,
         pub.slug AS publication_slug, pub.name AS publication_name, pub.logo_blossom_url AS publication_avatar,
         xs.protocol AS external_protocol, xs.source_uri AS external_source_uri,
         xs.display_name AS external_display_name, xs.avatar_url AS external_avatar
       FROM feed_sources fs
       LEFT JOIN accounts acc ON acc.id = fs.account_id
       LEFT JOIN publications pub ON pub.id = fs.publication_id
       LEFT JOIN external_sources xs ON xs.id = fs.external_source_id
       WHERE fs.id = $1`,
      [rows[0].id],
    )
    return sourceRowToResponse(hydrated[0])
  } catch (err) {
    // Per-type partial unique indexes on (feed_id, target) raise 23505 when
    // the user tries to add the same target twice.
    if ((err as { code?: string } | null)?.code === '23505') throw tagged('DUPLICATE')
    throw err
  }
}

function tagged(code: string): Error & { code: string } {
  const e = new Error(code) as Error & { code: string }
  e.code = code
  return e
}

// -----------------------------------------------------------------------------
// Source-filtered items query — slice 4. Fans out across the four source_type
// branches via OR-ed EXISTS clauses against feed_sources scoped to the feed.
// Cursor uses (published_at, id) since slice 4 doesn't yet rank by score
// across sources — chronological is honest until weight + sampling_mode wire
// in. Mute is applied per-row via muted_at.
// -----------------------------------------------------------------------------
async function sourceFilteredItems(
  readerId: string,
  feedId: string,
  rawCursor: string | undefined,
  limit: number,
) {
  const cursor = parseCursor(rawCursor)
  const cursorClause = cursor
    ? `AND (fi.published_at, fi.id) < (to_timestamp($4), $5::uuid)`
    : ''
  const params: any[] = cursor
    ? [readerId, feedId, limit, cursor.ts, cursor.id]
    : [readerId, feedId, limit]

  const result = await pool.query<any>(
    `
    SELECT ${FEED_SELECT}, a.title AS title
    FROM feed_items fi
    ${FEED_JOINS}
    WHERE fi.deleted_at IS NULL
      AND fi.author_id != $1
      AND NOT EXISTS (
        SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = fi.author_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = fi.author_id
      )
      AND (fi.item_type != 'note' OR n.reply_to_event_id IS NULL)
      AND (
        EXISTS (
          SELECT 1 FROM feed_sources fs
          WHERE fs.feed_id = $2 AND fs.muted_at IS NULL
            AND fs.source_type = 'account' AND fs.account_id = fi.author_id
        )
        OR EXISTS (
          SELECT 1 FROM feed_sources fs
          WHERE fs.feed_id = $2 AND fs.muted_at IS NULL
            AND fs.source_type = 'publication' AND fs.publication_id = a.publication_id
        )
        OR EXISTS (
          SELECT 1 FROM feed_sources fs
          WHERE fs.feed_id = $2 AND fs.muted_at IS NULL
            AND fs.source_type = 'external_source' AND fs.external_source_id = fi.source_id
        )
        OR EXISTS (
          SELECT 1 FROM feed_sources fs
          JOIN article_tags at_join ON at_join.article_id = fi.article_id
          JOIN tags t_join ON t_join.id = at_join.tag_id
          WHERE fs.feed_id = $2 AND fs.muted_at IS NULL
            AND fs.source_type = 'tag' AND fs.tag_name = t_join.name
        )
      )
      ${cursorClause}
    ORDER BY fi.published_at DESC, fi.id DESC
    LIMIT $3
  `,
    params,
  )

  const items = result.rows.map(rowToItem)
  const lastRow = result.rows[result.rows.length - 1]
  const nextCursor = lastRow
    ? `${Number(lastRow.published_at_epoch)}:${lastRow.fi_id}`
    : undefined

  return { items, nextCursor }
}

async function placeholderExploreItems(
  readerId: string,
  rawCursor: string | undefined,
  limit: number,
) {
  const cursor = parseCursor(rawCursor)
  const scoreCursor = cursor?.score ?? UNBOUNDED_SCORE
  const cursorClause = cursor
    ? `AND (fi.score, fi.published_at, fi.id) < ($3::numeric, to_timestamp($4), $5::uuid)`
    : ''
  const params: any[] = cursor
    ? [readerId, limit, scoreCursor, cursor.ts, cursor.id]
    : [readerId, limit]

  const result = await pool.query<any>(
    `
    SELECT ${FEED_SELECT}, a.title AS title
    FROM feed_items fi
    ${FEED_JOINS}
    WHERE fi.deleted_at IS NULL
      AND fi.published_at > now() - INTERVAL '48 hours'
      AND fi.item_type IN ('article', 'note')
      AND fi.author_id != $1
      AND NOT EXISTS (
        SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = fi.author_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = fi.author_id
      )
      AND (fi.item_type != 'note' OR n.reply_to_event_id IS NULL)
      ${cursorClause}
    ORDER BY fi.score DESC, fi.published_at DESC, fi.id DESC
    LIMIT $2
  `,
    params,
  )

  const items = result.rows.map(rowToItem)
  const lastRow = result.rows[result.rows.length - 1]
  const nextCursor = lastRow
    ? `${lastRow.score ?? 0}:${Number(lastRow.published_at_epoch)}:${lastRow.fi_id}`
    : undefined

  return { items, nextCursor }
}
