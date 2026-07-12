'use client'

// =============================================================================
// FollowImportSection — the paste-an-identity import path (FOLLOW-GRAPH-IMPORT
// -ADR §7.2, D8): any resolvable identity with a publicly readable graph can
// seed an import, no account link required. The input is omnivorous (universal
// resolver — handle, npub, NIP-05, DID, URL); resolved external accounts whose
// protocol the server can import offer "Import follows". The run hook is owned
// by the parent (NetworkReachPanel) so the per-presence "Import follows"
// affordance and this paste path share one at-a-time run + status area.
// =============================================================================

import { useResolverInput } from '../../hooks/useResolverInput'
import type { MatchOption } from '../../lib/workspace/resolve'
import type { UseFollowImportRun } from '../../hooks/useFollowImportRun'
import type { FollowImportProtocol } from '../../lib/api'
import { FollowImportStatus } from './FollowImportStatus'

export function FollowImportSection({
  importable,
  followImport,
}: {
  importable: string[]
  followImport: UseFollowImportRun
}) {
  const ri = useResolverInput({ maxPolls: 3 })

  const isCandidate = (m: MatchOption) =>
    m.add.sourceType === 'external_source' &&
    'sourceUri' in m.add &&
    importable.includes(m.add.protocol)
  const candidates = ri.matches.filter(isCandidate)
  // Resolved fine, but to a network whose graph we can't read yet (1c/1d) or
  // to something graph-less — say so rather than showing nothing.
  const onlyUnimportable =
    !ri.pending && ri.matches.length > 0 && candidates.length === 0

  const busy =
    followImport.starting ||
    followImport.run?.status === 'pending' ||
    followImport.run?.status === 'running'

  async function handleImport(opt: MatchOption) {
    if (opt.add.sourceType !== 'external_source' || !('sourceUri' in opt.add))
      return
    const ok = await followImport.start({
      protocol: opt.add.protocol as FollowImportProtocol,
      originIdentity: opt.add.sourceUri,
    })
    if (ok) ri.reset()
  }

  return (
    <div>
      <p className="text-ui-sm text-black">Bring your follows</p>
      <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
        Already follow people elsewhere? Paste a Bluesky handle, an npub, or a
        NIP-05 address and all.haus builds a new feed from everyone that account
        follows. One-way: nothing changes on the other network.
      </p>
      <input
        type="text"
        value={ri.query}
        onChange={e => ri.onQueryChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ri.submit()
          }
        }}
        placeholder="alice.bsky.social · npub1… · name@domain.com"
        className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm mt-3"
      />
      <div className="mt-2 space-y-1">
        {ri.resolving && (
          <p className="font-mono text-mono-xs text-grey-600">RESOLVING…</p>
        )}
        {(ri.doneEmpty || ri.resolveError) && (
          <p className="font-mono text-mono-xs text-grey-600">
            No match. Press Enter to search, or try a full handle, npub, or
            NIP-05 address.
          </p>
        )}
        {onlyUnimportable && (
          <p className="font-mono text-mono-xs text-grey-600">
            Found it, but importing follows isn&rsquo;t available for that
            network yet.
          </p>
        )}
        {candidates.map(opt => (
          <div
            key={opt.key}
            className="flex items-center justify-between gap-4"
          >
            <div className="min-w-0">
              <span className="text-ui-xs text-black truncate">
                {opt.label}
              </span>
              {opt.sublabel && (
                <span className="label-ui text-grey-600 ml-2">
                  {opt.sublabel}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleImport(opt)}
              disabled={busy}
              className="btn-text shrink-0"
            >
              Import follows
            </button>
          </div>
        ))}
        <FollowImportStatus
          starting={followImport.starting}
          run={followImport.run}
          feed={followImport.feed}
          error={followImport.error}
        />
      </div>
    </div>
  )
}
