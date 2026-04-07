'use client'

import { useState, useEffect } from 'react'
import type { FeedReach } from '../../lib/api'

const MODES: { value: FeedReach; label: string; description: string }[] = [
  { value: 'following', label: 'Following', description: 'Articles and notes from writers you follow' },
  { value: 'explore', label: 'Explore', description: 'Content from across the site' },
]

function getStoredReach(): FeedReach {
  if (typeof window === 'undefined') return 'explore'
  return (localStorage.getItem('feedReach') as FeedReach) || 'explore'
}

export function FeedDial() {
  const [reach, setReach] = useState<FeedReach>(getStoredReach)

  useEffect(() => {
    localStorage.setItem('feedReach', reach)
    window.dispatchEvent(new CustomEvent('feedReachChanged', { detail: reach }))
  }, [reach])

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">Feed reach</p>
      <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
        Choose what appears in your feed.
      </p>
      <div className="space-y-2">
        {MODES.map(mode => (
          <button
            key={mode.value}
            onClick={() => setReach(mode.value)}
            className={`w-full text-left px-4 py-3 transition-colors ${
              reach === mode.value
                ? 'bg-black text-white'
                : 'bg-white text-black hover:bg-grey-50'
            }`}
          >
            <p className={`text-ui-sm font-medium ${reach === mode.value ? 'text-white' : 'text-black'}`}>
              {mode.label}
            </p>
            <p className={`text-ui-xs mt-0.5 ${reach === mode.value ? 'text-grey-300' : 'text-grey-400'}`}>
              {mode.description}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}
