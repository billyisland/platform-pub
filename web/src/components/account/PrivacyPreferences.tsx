'use client'

import { useEffect, useState } from 'react'
import { privacyPreferences } from '../../lib/api'

export function PrivacyPreferences() {
  const [publishFollowGraph, setPublishFollowGraph] = useState<boolean | null>(null)

  useEffect(() => {
    privacyPreferences.get()
      .then(res => setPublishFollowGraph(res.publishFollowGraph))
      .catch(() => setPublishFollowGraph(true))
  }, [])

  async function set(value: boolean) {
    if (publishFollowGraph === value) return
    const previous = publishFollowGraph
    setPublishFollowGraph(value)
    try {
      await privacyPreferences.update(value)
    } catch {
      setPublishFollowGraph(previous)
    }
  }

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">Privacy</p>
      <div className="flex items-center justify-between">
        <div className="pr-6">
          <p className="text-ui-sm text-black">Publish my follow list to Nostr</p>
          <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
            Publishes who you follow — here and across Nostr — as a public Nostr
            contact list, so others can discover your follows. This makes your
            follow list world-readable. Turn it off to keep it private to all.haus.
          </p>
        </div>
        <div className="flex shrink-0">
          <button
            onClick={() => set(true)}
            className={`label-ui toggle-chip ${
              publishFollowGraph === true ? 'toggle-chip-active' : 'toggle-chip-inactive'
            }`}
            disabled={publishFollowGraph === null}
          >
            On
          </button>
          <button
            onClick={() => set(false)}
            className={`label-ui toggle-chip ${
              publishFollowGraph === false ? 'toggle-chip-active' : 'toggle-chip-inactive'
            }`}
            disabled={publishFollowGraph === null}
          >
            Off
          </button>
        </div>
      </div>
    </div>
  )
}
