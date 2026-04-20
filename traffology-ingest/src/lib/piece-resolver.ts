import { pool } from '@platform-pub/shared/db/client.js'

// =============================================================================
// Piece resolver — lazy-creates traffology.pieces from public.articles
//
// The page script sends the public.articles.id UUID. This resolver maps it
// to a traffology.pieces.id, creating the row on first encounter.
// Handles race conditions (two beacons for the same article arriving
// simultaneously) via ON CONFLICT DO NOTHING + re-fetch.
// =============================================================================

// In-memory cache: articleId → pieceId
const cache = new Map<string, string>()

export async function resolvePieceId(articleId: string): Promise<string | null> {
  const cached = cache.get(articleId)
  if (cached) return cached

  // Check if piece already exists
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM traffology.pieces WHERE article_id = $1',
    [articleId],
  )

  if (existing.rows.length > 0) {
    cache.set(articleId, existing.rows[0].id)
    return existing.rows[0].id
  }

  // Lazy-create from public.articles
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO traffology.pieces (article_id, writer_id, publication_id, title, external_url, word_count, nostr_event_id, published_at)
     SELECT a.id, a.writer_id, a.publication_id, a.title,
            CONCAT('/article/', a.nostr_d_tag), a.word_count, a.nostr_event_id, a.published_at
     FROM public.articles a
     WHERE a.id = $1 AND a.deleted_at IS NULL
     ON CONFLICT (article_id) DO NOTHING
     RETURNING id`,
    [articleId],
  )

  if (inserted.rows.length > 0) {
    cache.set(articleId, inserted.rows[0].id)
    return inserted.rows[0].id
  }

  // Race condition: another beacon created it. Re-fetch.
  const refetch = await pool.query<{ id: string }>(
    'SELECT id FROM traffology.pieces WHERE article_id = $1',
    [articleId],
  )

  if (refetch.rows.length > 0) {
    cache.set(articleId, refetch.rows[0].id)
    return refetch.rows[0].id
  }

  // Article doesn't exist or is deleted
  return null
}
