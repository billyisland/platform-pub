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

// Aggregate no-silent-caps facts for an OPML upload (§6.5): identity-cap
// truncation, folders folded into the base feed by the feed cap, and invalid
// entries dropped at parse time — the upload summary states them all.
export interface OpmlImportPlanSummary {
  totalEntries: number
  remoteTotal: number
  truncated: boolean
  cap: number
  foldedFolders: number
  invalidEntries: number
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

  // OPML upload (Phase 1d): folders map to one feed per folder under the
  // server's feed cap, so one upload can mint SEVERAL runs.
  createOpml: (data: { opml: string; feedName?: string }) =>
    request<{
      runs: { import: FollowImportCreated; feed: WorkspaceFeed }[]
      plan: OpmlImportPlanSummary
    }>('/follow-imports/opml', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (id: string) =>
    request<{ import: FollowImportRun }>(`/follow-imports/${id}`),
}
