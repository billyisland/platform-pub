'use client'

import { useEffect, useState } from 'react'
import { linkedAccounts, type LinkedAccount } from '../../lib/api'

export function LinkedAccountsPanel() {
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [instanceUrl, setInstanceUrl] = useState('')
  const [blueskyHandle, setBlueskyHandle] = useState('')
  const [showConnect, setShowConnect] = useState<null | 'mastodon' | 'bluesky'>(null)

  async function load() {
    try {
      const { accounts } = await linkedAccounts.list()
      setAccounts(accounts)
    } catch (err: any) {
      setError(err.message ?? 'Failed to load linked accounts')
    }
  }

  useEffect(() => { load() }, [])

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

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">Connected accounts</p>
      <div className="bg-white px-6 py-5">
        <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">
          Connect external accounts to cross-post your replies and quotes back to their original platforms.
        </p>

        {accounts === null ? (
          <div className="h-12 animate-pulse bg-grey-100" />
        ) : accounts.length === 0 ? (
          <p className="text-ui-xs text-grey-500 mb-4">No accounts connected yet.</p>
        ) : (
          <ul className="space-y-3 mb-4">
            {accounts.map(acct => (
              <li key={acct.id} className="flex items-center justify-between gap-4 border-b border-grey-100 pb-3 last:border-b-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="label-ui text-grey-500">{protocolLabel(acct.protocol)}</span>
                    {!acct.isValid && <span className="label-ui text-red-600">Invalid</span>}
                  </div>
                  <p className="text-ui-sm text-black truncate">{acct.externalHandle ?? acct.externalId}</p>
                </div>
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
              </li>
            ))}
          </ul>
        )}

        {showConnect === 'mastodon' ? (
          <div className="border-t border-grey-100 pt-4">
            <p className="label-ui text-grey-400 mb-2">Mastodon instance</p>
            <input
              type="text"
              value={instanceUrl}
              onChange={e => setInstanceUrl(e.target.value)}
              placeholder="mastodon.social"
              autoFocus
              className="w-full bg-grey-100 px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm"
              onKeyDown={e => { if (e.key === 'Enter') handleConnectMastodon() }}
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
        ) : showConnect === 'bluesky' ? (
          <div className="border-t border-grey-100 pt-4">
            <p className="label-ui text-grey-400 mb-2">Bluesky handle</p>
            <input
              type="text"
              value={blueskyHandle}
              onChange={e => setBlueskyHandle(e.target.value)}
              placeholder="alice.bsky.social"
              autoFocus
              className="w-full bg-grey-100 px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm"
              onKeyDown={e => { if (e.key === 'Enter') handleConnectBluesky() }}
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
        ) : (
          <div className="flex gap-4">
            <button onClick={() => setShowConnect('mastodon')} className="btn-text">
              + Connect Mastodon
            </button>
            <button onClick={() => setShowConnect('bluesky')} className="btn-text">
              + Connect Bluesky
            </button>
          </div>
        )}

        {error && <p className="text-ui-xs text-red-600 mt-3">{error}</p>}
      </div>
    </div>
  )
}

function protocolLabel(p: LinkedAccount['protocol']): string {
  switch (p) {
    case 'activitypub': return 'Mastodon'
    case 'atproto': return 'Bluesky'
    case 'nostr_external': return 'Nostr'
    case 'rss': return 'RSS'
  }
}
