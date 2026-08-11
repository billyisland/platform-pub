import { request, ApiError } from './client'

// =============================================================================
// Feed formulas — a feed's composition as a transmissible object
// (FEED-FORMULAS-ADR, Phase 1).
//
// A formula is a feed's SOURCE LIST, frozen and given a link. Never its
// contents: nobody's items appear on a formula page, which is why nothing in
// this module carries a Post.
//
// The routes live on two prefixes, deliberately (ADR §12): freeze is genuinely
// feed-scoped and sits under /workspace, while the page a stranger opens is
// public and would be a lie about its audience if served from a path called
// "workspace".
// =============================================================================

/** One source as a recipient reads it. Display-only, by construction. */
export interface FormulaSource {
  position: number
  kind: 'account' | 'publication' | 'external_source' | 'tag'
  protocol: string | null
  label: string
  avatar: string | null
}

// The one-word kind a source is filed under, shown beside its name on both the
// public page and the composer's publish preview. ONE home so the two cannot
// describe the same composition differently — the preview's whole claim is that
// it is what the recipient will see.
const PROTOCOL_LABELS: Record<string, string> = {
  rss: 'RSS',
  atproto: 'BLUESKY',
  activitypub: 'FEDIVERSE',
  nostr_external: 'NOSTR',
}

export function formulaSourceKind(s: FormulaSource): string {
  if (s.kind === 'account') return 'WRITER'
  if (s.kind === 'publication') return 'PUBLICATION'
  if (s.kind === 'tag') return 'TAG'
  return (s.protocol && PROTOCOL_LABELS[s.protocol]) ?? 'EXTERNAL'
}

export interface Formula {
  name: string
  description: string | null
  // The author's colour scheme travels with the composition (§5) — the feed
  // ARRIVES styled and the recipient restyles it afterwards like any feed.
  appearance: { scheme?: string; density?: string }
  // D7 — attribution travels, adoption counts do not. There is deliberately no
  // add count on this object, public or private.
  author: { displayName: string | null; username: string | null }
  sourceCount: number
  // Named out loud, never silently omitted (D5): an author who published a feed
  // holding three email sources must be able to see that three did not travel.
  excludedCount: number
  createdAt: string
  revoked: boolean
  sources: FormulaSource[]
}

/** A formula as its own author sees it — the same object plus its link. */
export interface OwnedFormula extends Formula {
  id: string
  token: string
  url: string
  isDefaultSeed: boolean
}

/**
 * The recipient's-eye view BEFORE the freeze (§6, D5).
 *
 * `refusal` is what the freeze would refuse on, reported rather than thrown so
 * the publish sheet can say why the button is unavailable instead of letting
 * the author press it and read a 400.
 */
export interface FormulaPreview {
  sources: FormulaSource[]
  sourceCount: number
  excludedCount: number
  refusal: 'empty' | 'too_large' | null
  /** What the freeze would use if the author renames nothing. */
  name: string
  appearance: { scheme?: string; density?: string }
  maxSources: number
}

/** Sources that did not resolve at redeem. A partial redeem is a real outcome
 *  (§6), so this is reported rather than swallowed — a redeem that quietly
 *  dropped four sources would read to the recipient as the author's own
 *  composition. */
export interface RedeemFailure {
  position: number
  label: string
  reason: 'unresolvable' | 'unreachable' | 'invalid' | 'error'
}

export interface RedeemResult {
  feedId: string
  added: number
  failed: RedeemFailure[]
}

export const formulas = {
  preview: (feedId: string) =>
    request<{ preview: FormulaPreview }>(
      `/workspace/feeds/${feedId}/formula/preview`,
    ).then((r) => r.preview),

  publish: (feedId: string, body: { name?: string; description?: string }) =>
    request<{ formula: OwnedFormula }>(`/workspace/feeds/${feedId}/formula`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.formula),

  /** The public page's data. Works logged-out — only redeeming needs an
   *  account. */
  get: (token: string) =>
    request<{ formula: Formula }>(
      `/formulas/${encodeURIComponent(token)}`,
    ).then((r) => r.formula),

  redeem: (token: string) =>
    request<RedeemResult>(`/formulas/${encodeURIComponent(token)}/redeem`, {
      method: 'POST',
    }),

  listMine: () =>
    request<{ formulas: OwnedFormula[] }>('/my/formulas').then(
      (r) => r.formulas,
    ),

  /** D10 — revoking cannot un-add. It stops FUTURE redemptions and nothing
   *  else; no feed anywhere is touched. */
  revoke: (id: string) =>
    request<void>(`/formulas/${id}`, { method: 'DELETE' }),
}

// ---------------------------------------------------------------------------
// The dark-ship gate
//
// FEED_FORMULAS_ENABLED is a SERVER flag and stays the only one: the brake
// rule says put it at the narrowest server-side choke point and add a
// NEXT_PUBLIC twin only when the web must change LAYOUT rather than omit data
// — and the composer's publish action is exactly that layout case, since an
// action that 404s on press is worse than an action that is absent.
//
// So rather than a second flag to flip in lockstep, the web ASKS. Every formula
// route 404s while the flag is dark, and `/my/formulas` is the one that needs
// no arguments and no side effects, so reaching it IS the proof — the same
// shape as the gateway's internal-parity probe.
//
// TERMINAL VS AMBIGUOUS, and the distinction is why this is cached at all:
//   200 → live, cache true.
//   404 → dark, cache false. A definitive answer from a route that exists.
//   anything else (401 mid-logout, 5xx, offline) → treat as dark for THIS
//     render but cache NOTHING, so a network blip cannot switch the feature off
//     for the rest of the session.
// ---------------------------------------------------------------------------

let availability: Promise<boolean> | null = null

export function formulasAvailable(): Promise<boolean> {
  if (!availability) {
    availability = formulas
      .listMine()
      .then(() => true)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return false
        availability = null
        return false
      })
  }
  return availability
}

/** Drop the cached verdict. The answer is a property of the SERVER flag and not
 *  of the viewer, so this deliberately does NOT hang off logout the way
 *  `useFollows` does — it exists for an operator flipping the flag under a live
 *  tab in dev. */
export function resetFormulaAvailability() {
  availability = null
}
