import type { PoolClient } from 'pg'
import type { NormalisedAtprotoItem } from '../adapters/atproto.js'

// =============================================================================
// Shared atproto ingest write path — used by both the Jetstream listener and
// the backfill job. Dual-writes external_items + feed_items with the same
// ON CONFLICT DO NOTHING pattern, so either caller can safely rewrite the
// same post without producing duplicate rows.
//
// Returns true if a new external_items row was inserted (i.e. not a dedupe
// hit), so callers can count newly-ingested items.
// =============================================================================

interface AtprotoIngestSource {
  id: string
  source_uri: string
  display_name: string | null
  avatar_url: string | null
}

export async function insertAtprotoItem(
  client: PoolClient,
  source: AtprotoIngestSource,
  item: NormalisedAtprotoItem
): Promise<boolean> {
  const { rows, rowCount } = await client.query<{ id: string }>(`
    INSERT INTO external_items (
      source_id, protocol, tier,
      source_item_uri,
      author_name, author_handle, author_avatar_url, author_uri,
      content_text, content_html, language,
      media,
      source_reply_uri, source_quote_uri, is_repost,
      interaction_data,
      published_at
    ) VALUES (
      $1, 'atproto', 'tier3',
      $2,
      $3, $4, $5, $6,
      $7, $8, $9,
      $10,
      $11, $12, FALSE,
      $13,
      $14
    )
    ON CONFLICT (protocol, source_item_uri) DO NOTHING
    RETURNING id
  `, [
    source.id,
    item.sourceItemUri,
    source.display_name ?? null,
    null,
    source.avatar_url ?? null,
    source.source_uri,
    item.contentText,
    item.contentHtml,
    item.language,
    JSON.stringify(item.media),
    item.sourceReplyUri,
    item.sourceQuoteUri,
    JSON.stringify(item.interactionData),
    item.publishedAt,
  ])

  if (!rowCount || rowCount === 0) return false

  await client.query(`
    INSERT INTO feed_items (
      item_type, external_item_id,
      author_name, author_avatar,
      title, content_preview,
      tier, published_at,
      source_protocol, source_item_uri, source_id
    ) VALUES (
      'external', $1,
      $2, $3,
      NULL, $4,
      'tier3', $5,
      'atproto', $6, $7
    )
    ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING
  `, [
    rows[0].id,
    source.display_name ?? 'Bluesky user',
    source.avatar_url,
    (item.contentText ?? '').slice(0, 200),
    item.publishedAt,
    item.sourceItemUri,
    source.id,
  ])

  return true
}
