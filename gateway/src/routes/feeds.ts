import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Workspace feeds (slice 3)
//
// GET    /feeds              — list feeds owned by the caller
// POST   /feeds              — create { name }
// PATCH  /feeds/:id          — rename { name }
// DELETE /feeds/:id          — delete (cascade removes feed_sources)
// GET    /feeds/:id/items    — feed contents
//
// Slice 3 ships schema + CRUD + an empty-sources placeholder for /items:
// when a feed has no feed_sources rows yet, /items returns the caller's
// explore feed unchanged. Source-set semantics (per-source pulls, weighting,
// sampling) arrive in a later slice.
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
        if (feed.source_count === 0) {
          // Placeholder: until source-set semantics are wired, an empty feed
          // surfaces the platform's explore stream so the vessel is useful
          // out of the box. The route is intentionally a thin proxy onto the
          // existing /feed handler logic — once sources arrive this branch
          // narrows to "no sources → empty result".
          const limit = Math.min(parseInt(req.query.limit ?? '20', 10) || 20, 50)
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

        // TODO(slice-4+): query feed_items filtered by feed_sources.
        return reply.send({
          feed: feedRowToResponse(feed),
          items: [],
          nextCursor: undefined,
          placeholder: false,
        })
      } catch (err) {
        logger.error({ err, feedId: id }, 'Feed items fetch failed')
        return reply.status(500).send({ error: 'Feed items fetch failed' })
      }
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
