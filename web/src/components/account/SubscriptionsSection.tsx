'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { account as accountApi, type MySubscription } from '../../lib/api'

export function SubscriptionsSection() {
  const [subs, setSubs] = useState<MySubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const data = await accountApi.getMySubscriptions()
        setSubs(data.subscriptions)
      } catch {}
      finally { setLoading(false) }
    })()
  }, [])

  async function handleCancel(subId: string) {
    if (!confirm('Cancel this subscription?')) return
    setCancellingId(subId)
    try {
      await fetch(`/api/v1/subscriptions/${subId}`, { method: 'DELETE', credentials: 'include' })
      setSubs(prev => prev.filter(s => s.id !== subId))
    } catch { alert('Failed to cancel subscription.') }
    finally { setCancellingId(null) }
  }

  if (loading) return <div className="h-12 animate-pulse bg-white" />
  if (subs.length === 0) return null

  return (
    <div className="mb-10">
      <p className="label-ui text-grey-400 mb-4">Subscriptions</p>
      <div className="bg-white divide-y divide-grey-200/50">
        {subs.map(s => (
          <div key={s.id} className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3 min-w-0">
              {s.writerAvatar ? (
                <img src={s.writerAvatar} alt="" className="h-8 w-8 rounded-full object-cover flex-shrink-0" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center bg-grey-100 text-[11px] font-mono text-grey-400 rounded-full flex-shrink-0">
                  {(s.writerDisplayName ?? s.writerUsername ?? '?')[0].toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <Link href={`/${s.writerUsername}`} className="text-[14px] font-sans font-medium text-black hover:opacity-70 truncate block">
                  {s.writerDisplayName ?? s.writerUsername}
                </Link>
                <p className="font-mono text-[11px] text-grey-300 uppercase tracking-[0.06em]">@{s.writerUsername}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <span className="font-mono text-[12px] text-black tabular-nums">£{(s.pricePence / 100).toFixed(2)}/mo</span>
              <button
                onClick={() => handleCancel(s.id)}
                disabled={cancellingId === s.id}
                className="text-[13px] font-sans text-grey-300 hover:text-black disabled:opacity-50"
              >
                {cancellingId === s.id ? '…' : 'Cancel'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
