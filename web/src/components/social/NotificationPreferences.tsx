'use client'

import { useState, useEffect } from 'react'
import { notifications } from '../../lib/api'

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'new_follower', label: 'New followers' },
  { key: 'new_reply', label: 'Replies to your articles' },
  { key: 'new_mention', label: 'Mentions' },
  { key: 'new_quote', label: 'Quotes of your work' },
  { key: 'commission_request', label: 'Commission requests' },
  { key: 'pub_events', label: 'Publication events' },
  { key: 'subscription_activity', label: 'Subscription activity' },
]

export function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    notifications.getPreferences()
      .then(res => setPrefs(res.preferences))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function toggle(category: string) {
    const newValue = !prefs[category]
    setPrefs(p => ({ ...p, [category]: newValue }))
    try {
      await notifications.setPreference(category, newValue)
    } catch {
      setPrefs(p => ({ ...p, [category]: !newValue }))
    }
  }

  if (loading) {
    return (
      <div>
        <p className="label-ui text-grey-400 mb-4">Notification preferences</p>
        <div className="space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-12 animate-pulse bg-white" />)}
        </div>
      </div>
    )
  }

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">Notification preferences</p>
      <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
        Choose which events generate notifications.
      </p>
      <div className="bg-white divide-y divide-grey-200/50">
        {CATEGORIES.map(cat => (
          <div key={cat.key} className="flex items-center justify-between px-4 py-3">
            <span className="text-[14px] font-sans text-black">{cat.label}</span>
            <div className="flex">
              <button
                onClick={() => { if (!prefs[cat.key]) return; toggle(cat.key) }}
                className={`px-2.5 py-1 text-[12px] font-mono uppercase tracking-[0.06em] transition-colors ${
                  prefs[cat.key]
                    ? 'bg-black text-white'
                    : 'bg-grey-100 text-grey-400 hover:text-black'
                }`}
              >
                On
              </button>
              <button
                onClick={() => { if (prefs[cat.key] === false) return; toggle(cat.key) }}
                className={`px-2.5 py-1 text-[12px] font-mono uppercase tracking-[0.06em] transition-colors ${
                  prefs[cat.key] === false
                    ? 'bg-black text-white'
                    : 'bg-grey-100 text-grey-400 hover:text-black'
                }`}
              >
                Off
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
