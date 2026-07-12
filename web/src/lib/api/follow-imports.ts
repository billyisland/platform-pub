import { request } from './client'
import type { WorkspaceFeed } from './feeds'

// =============================================================================
// Follow-graph import runs (FOLLOW-GRAPH-IMPORT-ADR §7). POST reads the remote
// graph synchronously (allow a few seconds), mints the feed + run row, and the
// gateway sweep populates it in the background; GET is the progress poll.
// Which protocols are importable comes from the /linked-accounts capabilities
// block (`followImportProtocols`) — empty while the server flag is dark.
// =============================================================================

export type FollowImportProtocol =
  | 'atproto'
  | 'nostr_external'
  | 'activitypub'
  | 'rss'

export interface FollowImportRun {
  id: string
  protocol: FollowImportProtocol
  originIdentity: string
  feedId: string
  status: 'pending' | 'running' | 'done' | 'failed'
  total: number
  imported: number
  skipped: number
  failed: number
  error?: string | null
}

// The POST response additionally carries the origin label and the
// no-silent-caps truncation facts (§6.5) for the offer/summary copy.
export interface FollowImportCreated extends FollowImportRun {
  originLabel: string
  remoteTotal: number
  truncated: boolean
  cap: number
}

export const followImports = {
  create: (data: {
    protocol: FollowImportProtocol
    originIdentity: string
    feedName?: string
  }) =>
    request<{ import: FollowImportCreated; feed: WorkspaceFeed }>(
      '/follow-imports',
      { method: 'POST', body: JSON.stringify(data) },
    ),

  get: (id: string) =>
    request<{ import: FollowImportRun }>(`/follow-imports/${id}`),
}
