import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Author Migration Export
//
// GET /account/export — auth required (writer only)
//
// Returns a portable bundle of all data a writer needs to leave the platform
// and re-host their content elsewhere:
//
//   account       — Nostr pubkey, username, display name
//   articles      — list of published articles with nostrEventId + dTag so the
//                   writer can re-fetch the signed events from the relay
//   contentKeys   — each paywalled article's content key wrapped with NIP-44
//                   to the writer's own pubkey (decrypt with writer's privkey
//                   to get the raw 32-byte key, then use algorithm to decrypt)
//   receiptWhitelist — per-article list of reader Nostr pubkeys who have paid
//                   (another host can honour these readers without re-charging)
//
// The Nostr events themselves (profile kind 0, follow list kind 3, articles
// kind 30023) are published to the relay and can be fetched by the client
// using the writer's pubkey — they are not duplicated here.
// =============================================================================

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL ?? 'http://localhost:3002'
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? ''

interface ExportedKey {
  articleId: string
  nostrEventId: string
  dTag: string
  title: string
  algorithm: string
  encryptedKey: string
}

async function fetchExportedKeys(writerId: string, writerPubkey: string): Promise<ExportedKey[]> {
  const res = await fetch(`${KEY_SERVICE_URL}/writers/export-keys`, {
    headers: {
      'x-writer-id': writerId,
      'x-writer-pubkey': writerPubkey,
      'x-internal-secret': INTERNAL_SECRET,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(`Key export failed: ${res.status} — ${body?.error ?? 'unknown'}`)
  }

  const body = await res.json() as { keys: ExportedKey[] }
  return body.keys
}

export async function exportRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /account/export
  //
  // Returns the writer's full migration bundle as a JSON object.
  // The client (or writer's tools) can use this to migrate to another host.
  // ---------------------------------------------------------------------------

  app.get('/account/export', { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub!

    // Fetch writer's account
    const accountRow = await pool.query<{
      nostr_pubkey: string
      username: string | null
      display_name: string | null
      is_writer: boolean
    }>(
      `SELECT nostr_pubkey, username, display_name, is_writer
       FROM accounts
       WHERE id = $1 AND status = 'active'`,
      [writerId]
    )

    if (accountRow.rows.length === 0) {
      return reply.status(403).send({ error: 'Account not found' })
    }

    if (!accountRow.rows[0].is_writer) {
      return reply.status(403).send({ error: 'Writer account required' })
    }

    const account = accountRow.rows[0]

    // Fetch all published (non-deleted) articles for this writer
    const articlesRow = await pool.query<{
      id: string
      nostr_event_id: string
      nostr_d_tag: string
      title: string
      access_mode: string
      price_pence: number | null
      published_at: Date
    }>(
      `SELECT id, nostr_event_id, nostr_d_tag, title, access_mode, price_pence, published_at
       FROM articles
       WHERE writer_id = $1
         AND deleted_at IS NULL
       ORDER BY published_at DESC`,
      [writerId]
    )

    // Fetch receipt whitelist: distinct reader pubkeys per article for this writer
    // Only includes readers where the portable receipt was stored (reader_pubkey IS NOT NULL)
    const whitelistRow = await pool.query<{
      article_id: string
      reader_pubkeys: string[]
    }>(
      `SELECT article_id, array_agg(DISTINCT reader_pubkey) AS reader_pubkeys
       FROM read_events
       WHERE writer_id = $1
         AND reader_pubkey IS NOT NULL
       GROUP BY article_id`,
      [writerId]
    )

    const whitelistByArticle = new Map(
      whitelistRow.rows.map(r => [r.article_id, r.reader_pubkeys])
    )

    // Fetch content keys from key-service (wrapped to writer's own pubkey)
    let contentKeys: ExportedKey[] = []
    try {
      contentKeys = await fetchExportedKeys(writerId, account.nostr_pubkey)
    } catch (err) {
      logger.error({ err, writerId }, 'Failed to export content keys from key-service')
      return reply.status(502).send({ error: 'Failed to retrieve content keys' })
    }

    const contentKeysByArticleId = new Map(contentKeys.map(k => [k.articleId, k]))

    // Build articles list with key info merged in
    const articles = articlesRow.rows.map(a => {
      const keyInfo = contentKeysByArticleId.get(a.id)
      const readerPubkeys = whitelistByArticle.get(a.id) ?? []
      return {
        articleId: a.id,
        nostrEventId: a.nostr_event_id,
        dTag: a.nostr_d_tag,
        title: a.title,
        accessMode: a.access_mode,
        isPaywalled: a.access_mode === 'paywalled',
        pricePence: a.price_pence ?? 0,
        publishedAt: a.published_at.toISOString(),
        // Content key info — present only for paywalled articles
        ...(keyInfo && {
          algorithm: keyInfo.algorithm,
          encryptedKey: keyInfo.encryptedKey,  // NIP-44 wrapped to writer's own pubkey
        }),
        // Reader pubkeys who have paid (for receipt whitelisting on another host)
        readerPubkeys,
      }
    })

    logger.info(
      { writerId, articleCount: articles.length, keyCount: contentKeys.length },
      'Author migration export'
    )

    return reply.status(200).send({
      version: 1,
      exportedAt: new Date().toISOString(),
      account: {
        nostrPubkey: account.nostr_pubkey,
        username: account.username,
        displayName: account.display_name,
      },
      articles,
      // Summary counts for quick validation
      summary: {
        totalArticles: articles.length,
        paywallArticles: articles.filter(a => a.isPaywalled).length,
        contentKeysExported: contentKeys.length,
        uniqueReaders: new Set(articles.flatMap(a => a.readerPubkeys)).size,
      },
    })
  })
}
