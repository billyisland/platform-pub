import type { FastifyInstance } from 'fastify'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Feed (Phase 2 — single-table query via feed_items)
//
// GET /feed?reach=following|explore&cursor=<published_at>:<id>&limit=20
//
// Single endpoint with a "reach" dial:
//   following — chronological feed from followed authors (+ own content + external)
//   explore   — everything published on the platform, scored ranking
//
// Blocks and mutes are excluded at every level.
// External items are excluded from explore until the scoring worker ships.
//
// Cursor format changed from unix seconds to compound "published_at:id" for
// stable keyset pagination. Legacy numeric cursors are still accepted.
// =============================================================================

type Reach = 'following' | 'explore'

const VALID_REACH = new Set<Reach>(['following', 'explore'])
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

interface CursorParts {
  ts: number
  id: string
}

function parseCursor(raw: string | undefined): CursorParts | undefined {
  if (!raw) return undefined
  // Compound cursor: "unix_seconds:uuid"
  const colonIdx = raw.indexOf(':')
  if (colonIdx > 0 && raw.length > colonIdx + 1) {
    const ts = parseInt(raw.slice(0, colonIdx), 10)
    const id = raw.slice(colonIdx + 1)
    if (!isNaN(ts) && id.length >= 36) return { ts, id }
  }
  // Legacy: plain unix seconds (no id component — use max uuid for stable ordering)
  const ts = parseInt(raw, 10)
  if (!isNaN(ts)) return { ts, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }
  return undefined
}

function feedItemToResponse(row: any) {
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
    }
  }

  // external
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
  }
}

// Shared SELECT columns — feed_items + LEFT JOINs for type-specific fields
const FEED_SELECT = `
  fi.id AS fi_id, fi.item_type, fi.article_id, fi.note_id, fi.external_item_id,
  fi.author_id, fi.nostr_event_id, fi.source_protocol, fi.source_item_uri,
  fi.source_id, fi.media, fi.score, fi.tier,
  EXTRACT(EPOCH FROM fi.published_at)::bigint AS published_at_epoch,
  -- Author pubkey (native content only — single join covers both articles and notes)
  acc.nostr_pubkey AS nostr_pubkey,
  -- Article-specific (NULL for non-articles)
  a.nostr_d_tag, a.access_mode, a.price_pence, a.gate_position_pct,
  a.content_free, a.summary AS a_summary,
  COALESCE(
    (SELECT array_agg(t.name ORDER BY t.name)
     FROM article_tags at2 JOIN tags t ON t.id = at2.tag_id
     WHERE at2.article_id = a.id),
    '{}'
  ) AS tag_names,
  -- Note-specific (NULL for non-notes)
  n.content AS note_content, n.is_quote_comment,
  n.quoted_event_id, n.quoted_event_kind,
  n.quoted_excerpt, n.quoted_title, n.quoted_author,
  -- External-specific (NULL for non-external)
  ei.author_name AS ei_author_name, ei.author_handle AS ei_author_handle,
  ei.author_avatar_url AS ei_author_avatar_url, ei.author_uri AS ei_author_uri,
  ei.content_text AS ei_content_text, ei.content_html AS ei_content_html,
  ei.title AS ei_title, ei.summary AS ei_summary,
  ei.source_reply_uri AS ei_source_reply_uri,
  ei.source_quote_uri AS ei_source_quote_uri,
  xs.display_name AS source_display_name, xs.avatar_url AS source_avatar_url
`

const FEED_JOINS = `
  LEFT JOIN articles a ON a.id = fi.article_id
  LEFT JOIN notes n ON n.id = fi.note_id
  LEFT JOIN accounts acc ON acc.id = fi.author_id
  LEFT JOIN external_items ei ON ei.id = fi.external_item_id
  LEFT JOIN external_sources xs ON xs.id = fi.source_id
`

export async function feedRoutes(app: FastifyInstance) {

  app.get<{ Querystring: { reach?: string; cursor?: string; limit?: string } }>(
    '/feed', { preHandler: requireAuth }, async (req, reply) => {
    const readerId = req.session!.sub!
    const reach = (req.query.reach ?? 'following') as Reach
    const cursor = parseCursor(req.query.cursor)
    const limit = Math.min(parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT)

    if (!VALID_REACH.has(reach)) {
      return reply.status(400).send({ error: `Invalid reach: ${reach}. Must be one of: ${[...VALID_REACH].join(', ')}` })
    }

    try {
      const items = reach === 'following'
        ? await followingFeed(readerId, cursor, limit)
        : await exploreFeed(readerId, cursor, limit)

      return reply.send({ items, reach })
    } catch (err) {
      logger.error({ err, reach }, 'Feed fetch failed')
      return reply.status(500).send({ error: 'Feed fetch failed' })
    }
  })
}

// =============================================================================
// following — chronological from followed authors + own content + external subs
// =============================================================================

async function followingFeed(readerId: string, cursor: CursorParts | undefined, limit: number) {
  const cursorClause = cursor
    ? `AND (fi.published_at, fi.id) < (to_timestamp($3), $4::uuid)`
    : ''
  const params: any[] = cursor
    ? [readerId, limit, cursor.ts, cursor.id]
    : [readerId, limit]

  const result = await pool.query(`
    WITH capped_external AS (
      SELECT fi_inner.id AS feed_item_id,
             ROW_NUMBER() OVER (
               PARTITION BY fi_inner.source_id
               ORDER BY fi_inner.published_at DESC
             ) AS rn,
             COALESCE(es.daily_cap, 100) AS cap
      FROM feed_items fi_inner
      JOIN external_subscriptions es
        ON es.source_id = fi_inner.source_id
       AND es.subscriber_id = $1
       AND es.is_muted = FALSE
      WHERE fi_inner.item_type = 'external'
        AND fi_inner.deleted_at IS NULL
        AND fi_inner.published_at >= now() - INTERVAL '24 hours'
    )
    SELECT ${FEED_SELECT}
    FROM feed_items fi
    ${FEED_JOINS}
    WHERE fi.deleted_at IS NULL
      ${cursorClause}
      AND (
        -- Native content: from followed authors, self, or followed publications
        (fi.item_type IN ('article', 'note')
         AND (
           fi.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
           OR fi.author_id = $1
           OR fi.article_id IN (
             SELECT a2.id FROM articles a2
             JOIN publication_follows pf ON pf.publication_id = a2.publication_id
             WHERE pf.follower_id = $1
           )
         ))
        OR
        -- External content: from active, unmuted subscriptions, within daily cap
        (fi.id IN (
           SELECT feed_item_id FROM capped_external WHERE rn <= cap
         ))
      )
      -- Block/mute filters (native content only — external items have no author_id)
      AND NOT EXISTS (
        SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = fi.author_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = fi.author_id
      )
      -- Exclude reply notes (top-level only)
      AND (fi.item_type != 'note' OR n.reply_to_event_id IS NULL)
    ORDER BY fi.published_at DESC, fi.id DESC
    LIMIT $2
  `, params)

  return result.rows.map(feedItemToResponse)
}

// =============================================================================
// explore — everything published on the platform, scored ranking
// External items excluded until the scoring worker ships meaningful scores.
// =============================================================================

async function exploreFeed(readerId: string, cursor: CursorParts | undefined, limit: number) {
  // Explore uses score-based ordering for content, plus new users
  const cursorClause = cursor
    ? `AND EXTRACT(EPOCH FROM fi.published_at)::bigint < $3`
    : ''
  const newUserCursorClause = cursor
    ? `AND EXTRACT(EPOCH FROM acc2.created_at)::bigint < $3`
    : ''
  const params: any[] = cursor
    ? [readerId, limit, cursor.ts]
    : [readerId, limit]

  const [contentRes, newUsersRes] = await Promise.all([
    pool.query(`
      SELECT ${FEED_SELECT}
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
      ORDER BY fi.score DESC, fi.published_at DESC
      LIMIT $2
    `, params),
    pool.query(`
      SELECT acc2.username, acc2.display_name, acc2.avatar_blossom_url AS avatar,
        EXTRACT(EPOCH FROM acc2.created_at)::bigint AS joined_at
      FROM accounts acc2
      WHERE acc2.id != $1
        AND acc2.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $1)
        AND acc2.id NOT IN (SELECT muted_id FROM mutes WHERE muter_id = $1)
        ${newUserCursorClause}
      ORDER BY acc2.created_at DESC
      LIMIT $2
    `, params),
  ])

  // Preserve SQL score ordering for content; interleave new-user cards at fixed
  // positions (every NEW_USER_INTERVAL items) so scoring is not silently discarded.
  const content = contentRes.rows.map(feedItemToResponse)
  const newUsers = newUsersRes.rows.map(row => ({
    type: 'new_user' as const,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar,
    joinedAt: Number(row.joined_at),
  }))

  const NEW_USER_INTERVAL = 5
  const items: any[] = []
  let nuIdx = 0
  for (let i = 0; i < content.length; i++) {
    items.push(content[i])
    if ((i + 1) % NEW_USER_INTERVAL === 0 && nuIdx < newUsers.length) {
      items.push(newUsers[nuIdx++])
    }
  }
  while (nuIdx < newUsers.length) items.push(newUsers[nuIdx++])
  return items.slice(0, limit)
}
