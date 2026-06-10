'use client'

import { useEffect, useState } from 'react'
import { privacyPreferences } from '../../lib/api'

export function PrivacyPreferences() {
  const [discoveryEnabled, setDiscoveryEnabled] = useState<boolean | null>(null)
  const [publishFollowGraph, setPublishFollowGraph] = useState<boolean | null>(null)

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

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">Privacy</p>

      <div className="space-y-6">
        {/* Per-user Nostr public-presence opt-in */}
        <div className="flex items-center justify-between">
          <div className="pr-6">
            <p className="text-ui-sm text-black">Discoverable on Nostr</p>
            <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
              Publishes your profile and where to read you to the public Nostr
              network, so anyone using Nostr can find and follow you. Off keeps
              your presence inside all.haus.
            </p>
          </div>
          <div className="flex shrink-0">
            <button
              onClick={() => setDiscovery(true)}
              className={`label-ui toggle-chip ${
                discoveryEnabled === true ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
              disabled={discoveryEnabled === null}
            >
              On
            </button>
            <button
              onClick={() => setDiscovery(false)}
              className={`label-ui toggle-chip ${
                discoveryEnabled === false ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
              disabled={discoveryEnabled === null}
            >
              Off
            </button>
          </div>
        </div>

        {/* Follow-graph opt-out — only meaningful while discoverable */}
        <div className="flex items-center justify-between">
          <div className="pr-6">
            <p className="text-ui-sm text-black">Publish my follow list to Nostr</p>
            <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
              While you&apos;re discoverable, also publish who you follow as a
              public Nostr contact list, so others can discover your follows.
              Turn it off to keep your follow list private.
            </p>
          </div>
          <div className="flex shrink-0">
            <button
              onClick={() => setFollowGraph(true)}
              className={`label-ui toggle-chip ${
                publishFollowGraph === true ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
              disabled={publishFollowGraph === null || !discoveryEnabled}
            >
              On
            </button>
            <button
              onClick={() => setFollowGraph(false)}
              className={`label-ui toggle-chip ${
                publishFollowGraph === false ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
              disabled={publishFollowGraph === null || !discoveryEnabled}
            >
              Off
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
