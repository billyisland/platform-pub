import type { FastifyInstance } from 'fastify'
import { pool } from '../../shared/src/db/client.js'

// =============================================================================
// RSS Feed Routes
//
// Per ADR §II.6: "RSS/Atom output: platform.pub writers' public posts
// available as RSS at launch, for distribution."
//
// Two feeds:
//   GET /rss/:username     — articles by a specific writer
//   GET /rss               — recent articles across the platform
//
// Only the free section (pre-gate) of paywalled articles is included in
// the RSS body. This is consistent with how paywalled content works in the
// Nostr ecosystem — the NIP-23 event only contains the free section.
//
// Feed format: RSS 2.0 (broader client support than Atom)
// =============================================================================

const SITE_URL = process.env.APP_URL ?? 'https://platform.pub'

export async function rssRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /rss/:username — writer-specific RSS feed
  // ---------------------------------------------------------------------------

  app.get<{ Params: { username: string } }>(
    '/rss/:username',
    async (req, reply) => {
      const { username } = req.params

      const writerResult = await pool.query<{
        id: string
        display_name: string | null
        bio: string | null
      }>(
        `SELECT id, display_name, bio FROM accounts
         WHERE username = $1 AND status = 'active'`,
        [username]
      )

      if (writerResult.rows.length === 0) {
        return reply.status(404).send('Writer not found')
      }

      const writer = writerResult.rows[0]

      const { rows: articles } = await pool.query<{
        nostr_d_tag: string
        title: string
        summary: string | null
        content_free: string | null
        published_at: Date
      }>(
        `SELECT nostr_d_tag, title, summary, content_free, published_at
         FROM articles
         WHERE writer_id = $1 AND published_at IS NOT NULL AND deleted_at IS NULL
         ORDER BY published_at DESC
         LIMIT 20`,
        [writer.id]
      )

      const displayName = writer.display_name ?? username
      const feedUrl = `${SITE_URL}/rss/${username}`
      const writerUrl = `${SITE_URL}/${username}`

      const xml = buildRssFeed({
        title: `${displayName} — Platform`,
        description: writer.bio ?? `Articles by ${displayName} on Platform`,
        link: writerUrl,
        feedUrl,
        items: articles.map((a) => ({
          title: a.title,
          link: `${SITE_URL}/article/${a.nostr_d_tag}`,
          description: a.summary ?? truncate(stripHtml(a.content_free ?? ''), 300),
          content: a.content_free ?? '',
          pubDate: a.published_at,
        })),
      })

      reply.header('Content-Type', 'application/rss+xml; charset=utf-8')
      reply.header('Cache-Control', 'public, max-age=600') // 10 min cache
      return reply.send(xml)
    }
  )

  // ---------------------------------------------------------------------------
  // GET /rss — platform-wide recent articles feed
  // ---------------------------------------------------------------------------

  app.get('/rss', async (req, reply) => {
    const { rows: articles } = await pool.query<{
      nostr_d_tag: string
      title: string
      summary: string | null
      content_free: string | null
      published_at: Date
      writer_username: string
      writer_display_name: string | null
    }>(
      `SELECT a.nostr_d_tag, a.title, a.summary, a.content_free, a.published_at,
              w.username AS writer_username,
              w.display_name AS writer_display_name
       FROM articles a
       JOIN accounts w ON w.id = a.writer_id
       WHERE a.published_at IS NOT NULL AND a.deleted_at IS NULL AND w.status = 'active'
       ORDER BY a.published_at DESC
       LIMIT 30`
    )

    const xml = buildRssFeed({
      title: 'Platform — recent articles',
      description: 'Recent articles from writers on Platform',
      link: SITE_URL,
      feedUrl: `${SITE_URL}/rss`,
      items: articles.map((a) => ({
        title: a.title,
        link: `${SITE_URL}/article/${a.nostr_d_tag}`,
        description: a.summary ?? truncate(stripHtml(a.content_free ?? ''), 300),
        content: a.content_free ?? '',
        pubDate: a.published_at,
        author: a.writer_display_name ?? a.writer_username,
      })),
    })

    reply.header('Content-Type', 'application/rss+xml; charset=utf-8')
    reply.header('Cache-Control', 'public, max-age=300') // 5 min cache
    return reply.send(xml)
  })
}

// =============================================================================
// RSS XML builder
// =============================================================================

interface RssFeedParams {
  title: string
  description: string
  link: string
  feedUrl: string
  items: RssItem[]
}

interface RssItem {
  title: string
  link: string
  description: string
  content: string
  pubDate: Date
  author?: string
}

function buildRssFeed(params: RssFeedParams): string {
  const items = params.items.map((item) => `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <description>${escapeXml(item.description)}</description>
      <content:encoded><![CDATA[${item.content}]]></content:encoded>
      <pubDate>${item.pubDate.toUTCString()}</pubDate>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      ${item.author ? `<dc:creator>${escapeXml(item.author)}</dc:creator>` : ''}
    </item>`
  ).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(params.title)}</title>
    <description>${escapeXml(params.description)}</description>
    <link>${escapeXml(params.link)}</link>
    <atom:link href="${escapeXml(params.feedUrl)}" rel="self" type="application/rss+xml"/>
    <language>en</language>
    <generator>Platform</generator>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).replace(/\s+\S*$/, '') + '...'
}
