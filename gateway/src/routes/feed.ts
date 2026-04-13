import type { FastifyInstance } from 'fastify'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Feed
//
// GET /feed?reach=following|explore&cursor=<unix_seconds>&limit=20
//
// Single endpoint with a "reach" dial:
//   following — chronological feed from followed authors (+ own content)
//   explore   — everything published on the platform, chronological
//
// Blocks and mutes are excluded at every level.
// =============================================================================

type Reach = 'following' | 'explore'

const VALID_REACH = new Set<Reach>(['following', 'explore'])
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

// Shared SELECT columns for articles
const ARTICLE_COLS = `
  a.nostr_event_id, a.nostr_d_tag, a.title, a.summary, a.content_free,
  a.access_mode, a.price_pence, a.gate_position_pct,
  EXTRACT(EPOCH FROM a.published_at)::bigint AS published_at,
  acc.nostr_pubkey,
  COALESCE(
    (SELECT array_agg(t.name ORDER BY t.name)
     FROM article_tags at2 JOIN tags t ON t.id = at2.tag_id
     WHERE at2.article_id = a.id),
    '{}'
  ) AS tag_names
`

// Shared SELECT columns for notes
const NOTE_COLS = `
  n.nostr_event_id, n.content, n.is_quote_comment,
  n.quoted_event_id, n.quoted_event_kind,
  n.quoted_excerpt, n.quoted_title, n.quoted_author,
  EXTRACT(EPOCH FROM n.published_at)::bigint AS published_at,
  acc.nostr_pubkey
`

function articleToItem(row: any) {
  return {
    type: 'article' as const,
    nostrEventId: row.nostr_event_id,
    pubkey: row.nostr_pubkey,
    dTag: row.nostr_d_tag,
    title: row.title,
    summary: row.summary ?? '',
    contentFree: row.content_free ?? '',
    accessMode: row.access_mode,
    isPaywalled: row.access_mode === 'paywalled',
    pricePence: row.price_pence ?? undefined,
    gatePositionPct: row.gate_position_pct ?? undefined,
    publishedAt: Number(row.published_at),
    score: row.score != null ? Number(row.score) : undefined,
    tags: row.tag_names ?? [],
  }
}

function noteToItem(row: any) {
  return {
    type: 'note' as const,
    nostrEventId: row.nostr_event_id,
    pubkey: row.nostr_pubkey,
    content: row.content,
    isQuoteComment: row.is_quote_comment,
    quotedEventId: row.quoted_event_id ?? undefined,
    quotedEventKind: row.quoted_event_kind ?? undefined,
    quotedExcerpt: row.quoted_excerpt ?? undefined,
    quotedTitle: row.quoted_title ?? undefined,
    quotedAuthor: row.quoted_author ?? undefined,
    publishedAt: Number(row.published_at),
    score: row.score != null ? Number(row.score) : undefined,
  }
}

function externalToItem(row: any) {
  return {
    type: 'external' as const,
    id: row.id,
    sourceProtocol: row.protocol,
    sourceItemUri: row.source_item_uri,
    authorName: row.author_name,
    authorHandle: row.author_handle,
    authorAvatarUrl: row.author_avatar_url,
    authorUri: row.author_uri,
    contentText: row.content_text,
    contentHtml: row.content_html,
    title: row.title,
    summary: row.summary,
    media: row.media,
    publishedAt: Number(row.published_at),
    sourceName: row.source_display_name,
    sourceAvatar: row.source_avatar_url,
  }
}

// Block + mute exclusion subqueries (parameterised on reader ID)
const BLOCK_FILTER = (col: string, paramIdx: number) =>
  `${col} NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $${paramIdx})`
const MUTE_FILTER = (col: string, paramIdx: number) =>
  `${col} NOT IN (SELECT muted_id FROM mutes WHERE muter_id = $${paramIdx})`

export async function feedRoutes(app: FastifyInstance) {

  app.get<{ Querystring: { reach?: string; cursor?: string; limit?: string } }>(
    '/feed', { preHandler: requireAuth }, async (req, reply) => {
    const readerId = req.session!.sub!
    const reach = (req.query.reach ?? 'following') as Reach
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : undefined
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
// following — pure chronological from followed authors + own content
// =============================================================================

async function followingFeed(readerId: string, cursor: number | undefined, limit: number) {
  const cursorClause = cursor ? `AND EXTRACT(EPOCH FROM a.published_at)::bigint < $3` : ''
  const noteCursorClause = cursor ? `AND EXTRACT(EPOCH FROM n.published_at)::bigint < $3` : ''
  const extCursorClause = cursor ? `AND EXTRACT(EPOCH FROM ei.published_at)::bigint < $3` : ''
  const params: any[] = cursor ? [readerId, limit, cursor] : [readerId, limit]

  const [articlesRes, notesRes, externalRes] = await Promise.all([
    pool.query(`
      SELECT ${ARTICLE_COLS}
      FROM articles a
      JOIN accounts acc ON acc.id = a.writer_id
      WHERE a.deleted_at IS NULL
        AND a.published_at IS NOT NULL
        AND (
          a.writer_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
          OR a.writer_id = $1
          OR a.publication_id IN (SELECT publication_id FROM publication_follows WHERE follower_id = $1)
        )
        AND ${BLOCK_FILTER('a.writer_id', 1)}
        AND ${MUTE_FILTER('a.writer_id', 1)}
        ${cursorClause}
      ORDER BY a.published_at DESC
      LIMIT $2
    `, params),
    pool.query(`
      SELECT ${NOTE_COLS}
      FROM notes n
      JOIN accounts acc ON acc.id = n.author_id
      WHERE n.reply_to_event_id IS NULL
        AND (n.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1) OR n.author_id = $1)
        AND ${BLOCK_FILTER('n.author_id', 1)}
        AND ${MUTE_FILTER('n.author_id', 1)}
        ${noteCursorClause}
      ORDER BY n.published_at DESC
      LIMIT $2
    `, params),
    // Stream 3: external items from subscribed sources (with daily cap)
    pool.query(`
      WITH capped AS (
        SELECT ei.id,
               ROW_NUMBER() OVER (
                 PARTITION BY ei.source_id
                 ORDER BY ei.published_at DESC
               ) AS rn,
               COALESCE(es.daily_cap, 100) AS cap
        FROM external_items ei
        JOIN external_subscriptions es
          ON es.source_id = ei.source_id
         AND es.subscriber_id = $1
         AND es.is_muted = FALSE
        WHERE ei.deleted_at IS NULL
          AND ei.published_at >= now() - INTERVAL '24 hours'
      )
      SELECT ei.id, ei.protocol, ei.source_item_uri,
             ei.author_name, ei.author_handle, ei.author_avatar_url, ei.author_uri,
             ei.content_text, ei.content_html, ei.title, ei.summary, ei.media,
             EXTRACT(EPOCH FROM ei.published_at)::bigint AS published_at,
             xs.display_name AS source_display_name,
             xs.avatar_url AS source_avatar_url
      FROM external_items ei
      JOIN capped c ON c.id = ei.id AND c.rn <= c.cap
      JOIN external_sources xs ON xs.id = ei.source_id
      WHERE ei.deleted_at IS NULL
        ${extCursorClause}
      ORDER BY ei.published_at DESC
      LIMIT $2
    `, params),
  ])

  const items = [
    ...articlesRes.rows.map(articleToItem),
    ...notesRes.rows.map(noteToItem),
    ...externalRes.rows.map(externalToItem),
  ]
  items.sort((a, b) => b.publishedAt - a.publishedAt)
  return items.slice(0, limit)
}

// =============================================================================
// explore — everything published on the platform, chronological
// =============================================================================

async function exploreFeed(readerId: string, cursor: number | undefined, limit: number) {
  const cursorClause = cursor ? `AND EXTRACT(EPOCH FROM a.published_at)::bigint < $3` : ''
  const noteCursorClause = cursor ? `AND EXTRACT(EPOCH FROM n.published_at)::bigint < $3` : ''
  const newUserCursorClause = cursor ? `AND EXTRACT(EPOCH FROM acc.created_at)::bigint < $3` : ''
  const params: any[] = cursor ? [readerId, limit, cursor] : [readerId, limit]

  const [articlesRes, notesRes, newUsersRes] = await Promise.all([
    pool.query(`
      SELECT ${ARTICLE_COLS}
      FROM articles a
      JOIN accounts acc ON acc.id = a.writer_id
      WHERE a.deleted_at IS NULL
        AND a.published_at IS NOT NULL
        AND ${BLOCK_FILTER('a.writer_id', 1)}
        AND ${MUTE_FILTER('a.writer_id', 1)}
        ${cursorClause}
      ORDER BY a.published_at DESC
      LIMIT $2
    `, params),
    pool.query(`
      SELECT ${NOTE_COLS}
      FROM notes n
      JOIN accounts acc ON acc.id = n.author_id
      WHERE n.reply_to_event_id IS NULL
        AND ${BLOCK_FILTER('n.author_id', 1)}
        AND ${MUTE_FILTER('n.author_id', 1)}
        ${noteCursorClause}
      ORDER BY n.published_at DESC
      LIMIT $2
    `, params),
    pool.query(`
      SELECT acc.username, acc.display_name, acc.avatar,
        EXTRACT(EPOCH FROM acc.created_at)::bigint AS joined_at
      FROM accounts acc
      WHERE acc.id != $1
        AND ${BLOCK_FILTER('acc.id', 1)}
        AND ${MUTE_FILTER('acc.id', 1)}
        ${newUserCursorClause}
      ORDER BY acc.created_at DESC
      LIMIT $2
    `, params),
  ])

  const items: any[] = [
    ...articlesRes.rows.map(articleToItem),
    ...notesRes.rows.map(noteToItem),
    ...newUsersRes.rows.map(row => ({
      type: 'new_user' as const,
      username: row.username,
      displayName: row.display_name,
      avatar: row.avatar,
      joinedAt: Number(row.joined_at),
    })),
  ]
  items.sort((a: any, b: any) => (b.publishedAt ?? b.joinedAt) - (a.publishedAt ?? a.joinedAt))
  return items.slice(0, limit)
}
