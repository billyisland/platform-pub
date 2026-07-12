'use client'

// =============================================================================
// PostLinkImportOffer — the post-link follow-import prompt (FOLLOW-GRAPH-
// IMPORT-ADR §7.1). Rides the same ?linked= redirect channel as the connect
// banner: the gateway appends &follows=<count> to a successful Bluesky link
// while the import feature is live, the /settings shim forwards it, and
// SettingsPanel mounts this under the banner. Opt-in per run (D7) — the offer
// does nothing until the user says yes, and "Not now" costs nothing (the same
// import stays reachable from "Reach other networks" and the FeedComposer).
//
// Bluesky-only today (1a); the Mastodon offer lands with the 1c reader.
// =============================================================================

import { useEffect, useState } from 'react'
import { getNetworkCapabilities } from '../../lib/api/linked-accounts'
import { useLinkedAccounts } from '../../hooks/useLinkedAccounts'
import { useFollowImportRun } from '../../hooks/useFollowImportRun'
import { FollowImportStatus } from '../network/FollowImportStatus'

export function PostLinkImportOffer({ follows }: { follows: number | null }) {
  const [importable, setImportable] = useState<string[]>([])
  const [dismissed, setDismissed] = useState(false)
  const accounts = useLinkedAccounts()
  const followImport = useFollowImportRun()

  useEffect(() => {
    void getNetworkCapabilities().then(c =>
      setImportable(c.followImportProtocols ?? []),
    )
  }, [])

  const did =
    accounts?.find(a => a.protocol === 'atproto')?.externalId ?? null
  if (dismissed || !importable.includes('atproto') || !did) return null

  // The offer stays up until a run exists (an error keeps the buttons so the
  // user can retry); once started, the status line takes over.
  const inFlight = followImport.starting || followImport.run !== null

  return (
    <div className="bg-glasshouse-well/40 px-4 py-3 space-y-2">
      {followImport.run === null && (
        <>
          <p className="text-ui-sm text-black">
            {follows !== null && follows > 0
              ? `Import the ${follows} accounts you follow on Bluesky as a new feed?`
              : 'Import the accounts you follow on Bluesky as a new feed?'}
          </p>
          <p className="text-ui-xs text-grey-600 leading-relaxed">
            It lands as an ordinary feed — retune, redistribute, or delete it
            with the usual tools. One-way: nothing changes on Bluesky. You can
            also do this later from &ldquo;Reach other networks&rdquo;.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() =>
                void followImport.start({
                  protocol: 'atproto',
                  originIdentity: did,
                })
              }
              disabled={inFlight}
              className="btn-text"
            >
              Import
            </button>
            <button onClick={() => setDismissed(true)} className="btn-text-muted">
              Not now
            </button>
          </div>
        </>
      )}
      <FollowImportStatus
        starting={followImport.starting}
        run={followImport.run}
        feed={followImport.feed}
        error={followImport.error}
      />
    </div>
  )
}
