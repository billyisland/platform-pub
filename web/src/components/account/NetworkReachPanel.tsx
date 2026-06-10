'use client'

// =============================================================================
// NetworkReachPanel — "Reach other networks." (NETWORK-CONCIERGE-ADR §10)
//
// Your account *is* a Nostr identity (the custodial root). Every other network
// is a satellite presence reached one of two ways: LINK an account you already
// have (OAuth, live today) or have all.haus SET ONE UP for you (concierge —
// gated on Phase 2/3 §8.1, so its affordance renders disabled/"coming soon").
//
// Nostr is the degenerate concierge (§7): you already hold the root key, so
// "go public" is just the discovery opt-in — folded in here as the Nostr row
// (relocated from the old PrivacyPreferences panel) so the whole network-reach
// mental model lives in one place.
// =============================================================================

import { useEffect, useState } from 'react'
import { linkedAccounts, privacyPreferences, type LinkedAccount } from '../../lib/api'
import { ASSISTED_BLUESKY_CONSENT, type NetworkCapabilities } from '../../lib/api/linked-accounts'

type SatelliteKey = 'mastodon' | 'bluesky'

const SATELLITES: {
  key: SatelliteKey
  label: string
  protocol: LinkedAccount['protocol']
  conciergeHandle: string
}[] = [
  { key: 'bluesky', label: 'Bluesky', protocol: 'atproto', conciergeHandle: 'you.all.haus' },
  { key: 'mastodon', label: 'Mastodon', protocol: 'activitypub', conciergeHandle: '@you@all.haus' },
]

export function NetworkReachPanel() {
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null)
  const [capabilities, setCapabilities] = useState<NetworkCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [instanceUrl, setInstanceUrl] = useState('')
  const [blueskyHandle, setBlueskyHandle] = useState('')
  const [showConnect, setShowConnect] = useState<null | SatelliteKey>(null)
  // The ASSISTED consent gate (§6.1.1 S5) — distinct from the link form above.
  const [showAssisted, setShowAssisted] = useState<null | SatelliteKey>(null)

  // Nostr presence (the degenerate concierge) — relocated from PrivacyPreferences.
  const [discoveryEnabled, setDiscoveryEnabled] = useState<boolean | null>(null)
  const [publishFollowGraph, setPublishFollowGraph] = useState<boolean | null>(null)

  async function load() {
    try {
      const { accounts, capabilities } = await linkedAccounts.list()
      setAccounts(accounts)
      setCapabilities(capabilities ?? { assistedBluesky: false })
    } catch (err: any) {
      setError(err.message ?? 'Failed to load network presences')
    }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    privacyPreferences.get()
      .then(res => {
        setDiscoveryEnabled(res.discoveryEnabled)
        setPublishFollowGraph(res.publishFollowGraph)
      })
      .catch(() => {
        setDiscoveryEnabled(false)
        setPublishFollowGraph(true)
      })
  }, [])

  async function setDiscovery(value: boolean) {
    if (discoveryEnabled === value) return
    const previous = discoveryEnabled
    setDiscoveryEnabled(value)
    try {
      await privacyPreferences.update({ discoveryEnabled: value })
    } catch {
      setDiscoveryEnabled(previous)
    }
  }

  async function setFollowGraph(value: boolean) {
    if (publishFollowGraph === value) return
    const previous = publishFollowGraph
    setPublishFollowGraph(value)
    try {
      await privacyPreferences.update({ publishFollowGraph: value })
    } catch {
      setPublishFollowGraph(previous)
    }
  }

  async function handleConnectMastodon() {
    const trimmed = instanceUrl.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    if (!trimmed) return
    setConnecting(true)
    setError(null)
    try {
      const { authorizeUrl } = await linkedAccounts.connectMastodon(`https://${trimmed}`)
      window.location.href = authorizeUrl
    } catch (err: any) {
      setError(err.message ?? 'Failed to start connection')
      setConnecting(false)
    }
  }

  async function handleConnectBluesky() {
    const trimmed = blueskyHandle.trim().replace(/^@/, '')
    if (!trimmed) return
    setConnecting(true)
    setError(null)
    try {
      const { authorizeUrl } = await linkedAccounts.connectBluesky(trimmed)
      window.location.href = authorizeUrl
    } catch (err: any) {
      setError(err.message ?? 'Failed to start connection')
      setConnecting(false)
    }
  }

  async function handleAssistedBluesky() {
    setConnecting(true)
    setError(null)
    try {
      const { authorizeUrl } = await linkedAccounts.assistedBluesky()
      window.location.href = authorizeUrl
    } catch (err: any) {
      setError(err.message ?? 'Failed to start setup')
      setConnecting(false)
    }
  }

  async function handleDisconnect(id: string) {
    if (!confirm('Disconnect this account? Cross-posts will stop.')) return
    try {
      await linkedAccounts.remove(id)
      await load()
    } catch (err: any) {
      setError(err.message ?? 'Failed to disconnect')
    }
  }

  async function handleToggleDefault(acct: LinkedAccount) {
    try {
      await linkedAccounts.update(acct.id, { crossPostDefault: !acct.crossPostDefault })
      await load()
    } catch (err: any) {
      setError(err.message ?? 'Failed to update')
    }
  }

  const linkedFor = (protocol: LinkedAccount['protocol']) =>
    accounts?.find(a => a.protocol === protocol) ?? null

  return (
    <div>
      <p className="label-ui text-grey-600 mb-4">Reach other networks</p>
      <div className="bg-white px-6 py-5">
        <p className="text-ui-xs text-grey-600 mb-6 leading-relaxed">
          Your all.haus account is a Nostr identity. Reach outward to other networks —
          link an account you already have, or have all.haus set one up and run it for you.
        </p>

        <div className="space-y-8">
          {/* Nostr — the root, always present. "Go public" is the discovery opt-in. */}
          <div>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 pr-6">
                <p className="text-ui-sm text-black">Nostr</p>
                <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
                  {discoveryEnabled
                    ? 'Public. Your profile and where to read you are published to the Nostr network, so anyone on Nostr can find and follow you.'
                    : 'Your account is a Nostr identity, kept inside all.haus. Turn on discovery to publish it to the public Nostr network.'}
                </p>
              </div>
              <div className="flex shrink-0">
                <button
                  onClick={() => setDiscovery(true)}
                  className={`label-ui toggle-chip ${discoveryEnabled === true ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                  disabled={discoveryEnabled === null}
                >
                  Public
                </button>
                <button
                  onClick={() => setDiscovery(false)}
                  className={`label-ui toggle-chip ${discoveryEnabled === false ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                  disabled={discoveryEnabled === null}
                >
                  Private
                </button>
              </div>
            </div>

            {/* Follow-graph sub-opt-out — only meaningful while public */}
            {discoveryEnabled && (
              <div className="flex items-center justify-between gap-4 mt-4 pl-4">
                <p className="text-ui-xs text-grey-600 pr-6 leading-relaxed">
                  Also publish who you follow as a public Nostr contact list. Turn off to keep
                  your follow list private.
                </p>
                <div className="flex shrink-0">
                  <button
                    onClick={() => setFollowGraph(true)}
                    className={`label-ui toggle-chip ${publishFollowGraph === true ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                    disabled={publishFollowGraph === null}
                  >
                    On
                  </button>
                  <button
                    onClick={() => setFollowGraph(false)}
                    className={`label-ui toggle-chip ${publishFollowGraph === false ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                    disabled={publishFollowGraph === null}
                  >
                    Off
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Satellite networks — link yours, or (soon) concierge. */}
          {accounts === null ? (
            <div className="h-12 animate-pulse bg-grey-100" />
          ) : (
            SATELLITES.map(net => {
              const acct = linkedFor(net.protocol)
              // ASSISTED clears for Bluesky on Phase 2 (§6.1); Mastodon stays
              // "soon" pending Phase 3's instance question.
              const assistedAvailable = net.key === 'bluesky' && !!capabilities?.assistedBluesky
              return (
                <div key={net.key}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 pr-6">
                      <div className="flex items-center gap-2">
                        <p className="text-ui-sm text-black">{net.label}</p>
                        {acct && !acct.isValid && <span className="label-ui text-red-600">Invalid</span>}
                      </div>
                      {acct ? (
                        <p className="text-ui-sm text-grey-600 truncate mt-1">{acct.externalHandle ?? acct.externalId}</p>
                      ) : (
                        <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
                          Cross-post your notes and replies to {net.label}.
                        </p>
                      )}
                    </div>

                    {acct ? (
                      <div className="flex items-center gap-4 shrink-0">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={acct.crossPostDefault}
                            onChange={() => handleToggleDefault(acct)}
                            className="cursor-pointer"
                          />
                          <span className="label-ui text-grey-500">Default on</span>
                        </label>
                        <button onClick={() => handleDisconnect(acct.id)} className="btn-text-danger">
                          Disconnect
                        </button>
                      </div>
                    ) : (showConnect === net.key || showAssisted === net.key) ? null : (
                      <div className="flex items-center gap-4 shrink-0">
                        <button onClick={() => setShowConnect(net.key)} className="btn-text">
                          Link yours
                        </button>
                        {assistedAvailable ? (
                          <button onClick={() => setShowAssisted(net.key)} className="btn-text">
                            Set one up
                          </button>
                        ) : (
                          <span
                            className="label-ui text-grey-300 cursor-not-allowed"
                            title={`Coming soon: all.haus will set up a ${net.label} account for you.`}
                          >
                            Set one up · soon
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* "Set one up" promise — honest about who holds the keys (§10). For
                      ASSISTED (Bluesky, Phase 2) the network custodies; the future
                      custodial branded-handle path (Phase 4) is the "soon" framing. */}
                  {!acct && showAssisted !== net.key && (
                    <p className="text-ui-xs text-grey-400 mt-2 leading-relaxed">
                      {assistedAvailable
                        ? `Don't have a ${net.label} account? all.haus can set one up for you — you'll create a normal ${net.label} account that ${net.label} holds the keys to; all.haus just connects it.`
                        : `Don't have a ${net.label} account? Soon all.haus will set one up for you — guiding you through ${net.label}'s own signup so the account is yours.`}
                    </p>
                  )}

                  {/* ASSISTED consent gate (§6.1.1 S5) — explicit acknowledgement
                      that a real network account is being created mid-redirect. */}
                  {showAssisted === net.key && (
                    <div className="pt-4">
                      <p className="text-ui-xs text-grey-600 leading-relaxed max-w-md">
                        {ASSISTED_BLUESKY_CONSENT}
                      </p>
                      <div className="flex gap-3 mt-3">
                        <button onClick={handleAssistedBluesky} disabled={connecting} className="btn-text">
                          {connecting ? 'Redirecting…' : `Create ${net.label} account`}
                        </button>
                        <button onClick={() => setShowAssisted(null)} className="btn-text-muted">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Link-yours OAuth form (per network) */}
                  {showConnect === net.key && net.key === 'mastodon' && (
                    <div className="pt-4">
                      <p className="label-ui text-grey-400 mb-2">Mastodon instance</p>
                      <input
                        type="text"
                        value={instanceUrl}
                        onChange={e => setInstanceUrl(e.target.value)}
                        placeholder="mastodon.social"
                        autoFocus
                        className="w-full bg-grey-100 px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm"
                        onKeyDown={e => { if (e.key === 'Enter') void handleConnectMastodon() }}
                      />
                      <div className="flex gap-3 mt-3">
                        <button onClick={handleConnectMastodon} disabled={connecting || !instanceUrl.trim()} className="btn-text">
                          {connecting ? 'Redirecting…' : 'Continue'}
                        </button>
                        <button onClick={() => { setShowConnect(null); setInstanceUrl('') }} className="btn-text-muted">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {showConnect === net.key && net.key === 'bluesky' && (
                    <div className="pt-4">
                      <p className="label-ui text-grey-400 mb-2">Bluesky handle</p>
                      <input
                        type="text"
                        value={blueskyHandle}
                        onChange={e => setBlueskyHandle(e.target.value)}
                        placeholder="alice.bsky.social"
                        autoFocus
                        className="w-full bg-grey-100 px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm"
                        onKeyDown={e => { if (e.key === 'Enter') void handleConnectBluesky() }}
                      />
                      <div className="flex gap-3 mt-3">
                        <button onClick={handleConnectBluesky} disabled={connecting || !blueskyHandle.trim()} className="btn-text">
                          {connecting ? 'Redirecting…' : 'Continue'}
                        </button>
                        <button onClick={() => { setShowConnect(null); setBlueskyHandle('') }} className="btn-text-muted">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {error && <p className="text-ui-xs text-red-600 mt-4">{error}</p>}
      </div>
    </div>
  )
}
