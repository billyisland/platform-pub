import type { PoolClient } from 'pg'
import type { NormalisedActivityPubItem } from '../adapters/activitypub.js'

// =============================================================================
// ActivityPub dual-write — external_items + feed_items.
// Mirrors the atproto-ingest pattern. ON CONFLICT DO NOTHING so the
// occasional overlap between backfill and steady-state polling is safe.
// =============================================================================

export interface ActivityPubIngestSource {
  id: string
  source_uri: string
  display_name: string | null
  avatar_url: string | null
}

export async function insertActivityPubItem(
  client: PoolClient,
  source: ActivityPubIngestSource,
  item: NormalisedActivityPubItem
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
      $1, 'activitypub', 'tier3',
      $2,
      $3, $4, $5, $6,
      $7, $8, $9,
      $10,
      $11, NULL, FALSE,
      $12,
      $13
    )
    ON CONFLICT (protocol, source_item_uri) DO NOTHING
    RETURNING id
  `, [
    source.id,
    item.sourceItemUri,
    item.authorName ?? source.display_name ?? null,
    item.authorHandle,
    item.authorAvatarUrl ?? source.avatar_url ?? null,
    item.authorUri,
    item.contentText,
    item.contentHtml,
    item.language,
    JSON.stringify(item.media),
    item.sourceReplyUri,
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
      source_protocol, source_item_uri, source_id, media
    ) VALUES (
      'external', $1,
      $2, $3,
      NULL, $4,
      'tier3', $5,
      'activitypub', $6, $7, $8
    )
    ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING
  `, [
    rows[0].id,
    item.authorName ?? source.display_name ?? 'Mastodon user',
    item.authorAvatarUrl ?? source.avatar_url,
    (item.contentText ?? '').slice(0, 200),
    item.publishedAt,
    item.sourceItemUri,
    source.id,
    JSON.stringify(item.media),
  ])

  return true
}

// =============================================================================
// Per-instance success/failure counters — drive the admin health view and
// inform the ADR's "30% failure → inbox delivery" acceleration decision.
// =============================================================================

export async function recordInstanceSuccess(client: PoolClient, host: string): Promise<void> {
  await client.query(`
    INSERT INTO activitypub_instance_health (host, success_count, last_success_at)
    VALUES ($1, 1, now())
    ON CONFLICT (host) DO UPDATE SET
      success_count   = activitypub_instance_health.success_count + 1,
      last_success_at = now(),
      updated_at      = now()
  `, [host])
}

export async function recordInstanceFailure(
  client: PoolClient,
  host: string,
  error: string
): Promise<void> {
  await client.query(`
    INSERT INTO activitypub_instance_health (host, failure_count, last_failure_at, last_error)
    VALUES ($1, 1, now(), $2)
    ON CONFLICT (host) DO UPDATE SET
      failure_count   = activitypub_instance_health.failure_count + 1,
      last_failure_at = now(),
      last_error      = $2,
      updated_at      = now()
  `, [host, error.slice(0, 500)])
}
