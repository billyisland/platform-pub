'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { SubscribeInput } from '../../components/feed/SubscribeInput'
import { feeds, type ExternalSubscription } from '../../lib/api'
import { formatDateRelative } from '../../lib/format'

// =============================================================================
// Subscriptions page — manage external feed subscriptions
//
// Subscribe to new feeds via the omnivorous input, view existing
// subscriptions with health status, mute/unmute, remove.
// =============================================================================

const PROTOCOL_LABELS: Record<string, string> = {
  rss: 'RSS',
  atproto: 'BLUESKY',
  activitypub: 'MASTODON',
  nostr_external: 'NOSTR',
}

export default function SubscriptionsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [subscriptions, setSubscriptions] = useState<ExternalSubscription[]>([])
  const [loadingSubs, setLoadingSubs] = useState(true)

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  const loadSubscriptions = useCallback(async () => {
    try {
      const data = await feeds.list()
      setSubscriptions(data.subscriptions)
    } catch (err) {
      console.error('Failed to load subscriptions:', err)
    } finally {
      setLoadingSubs(false)
    }
  }, [])

  useEffect(() => {
    if (user) loadSubscriptions()
  }, [user, loadSubscriptions])

  const handleRemove = useCallback(async (id: string) => {
    try {
      await feeds.remove(id)
      setSubscriptions(prev => prev.filter(s => s.id !== id))
    } catch (err) {
      console.error('Failed to remove subscription:', err)
    }
  }, [])

  const handleToggleMute = useCallback(async (id: string, currentlyMuted: boolean) => {
    try {
      await feeds.update(id, { isMuted: !currentlyMuted })
      setSubscriptions(prev =>
        prev.map(s => s.id === id ? { ...s, isMuted: !currentlyMuted } : s)
      )
    } catch (err) {
      console.error('Failed to toggle mute:', err)
    }
  }, [])

  const handleRefresh = useCallback(async (id: string) => {
    try {
      await feeds.refresh(id)
    } catch (err) {
      console.error('Failed to refresh:', err)
    }
  }, [])

  if (loading || !user) return null

  return (
    <div className="mx-auto max-w-feed pt-8 pb-20 px-6">
      <h1 className="font-sans text-[28px] font-semibold text-black">External feeds</h1>
      <p className="text-ui-sm text-grey-600 mt-1">
        Subscribe to RSS feeds, Nostr accounts, and more. Content appears in your following feed.
      </p>

      {/* Subscribe input */}
      <div className="mt-6">
        <SubscribeInput onSubscribed={loadSubscriptions} />
      </div>

      {/* Subscription list */}
      <div className="mt-8">
        <hr className="slab-rule-4 mb-6" />

        {loadingSubs ? (
          <p className="text-ui-sm text-grey-400 py-8 text-center">Loading subscriptions...</p>
        ) : subscriptions.length === 0 ? (
          <p className="text-ui-sm text-grey-400 py-8 text-center">
            No subscriptions yet. Paste an RSS feed URL above to get started.
          </p>
        ) : (
          <div>
            {subscriptions.map(sub => (
              <SubscriptionRow
                key={sub.id}
                subscription={sub}
                onRemove={handleRemove}
                onToggleMute={handleToggleMute}
                onRefresh={handleRefresh}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SubscriptionRow({
  subscription: sub,
  onRemove,
  onToggleMute,
  onRefresh,
}: {
  subscription: ExternalSubscription
  onRemove: (id: string) => void
  onToggleMute: (id: string, muted: boolean) => void
  onRefresh: (id: string) => void
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const src = sub.source
  const badge = PROTOCOL_LABELS[src.protocol] ?? src.protocol.toUpperCase()
  const hasError = src.errorCount > 0
  const isInactive = !src.isActive

  return (
    <div className={`py-4 border-b border-grey-200 ${sub.isMuted ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Source name + badge */}
          <div className="flex items-center gap-2">
            {src.avatarUrl && (
              <img src={src.avatarUrl} alt="" className="w-5 h-5 object-cover flex-shrink-0 bg-grey-200" loading="lazy" />
            )}
            <span className="text-ui-sm font-semibold text-black truncate">
              {src.displayName ?? src.sourceUri}
            </span>
            <span className="label-ui text-grey-400">{badge}</span>
            {src.protocol === 'activitypub' && (
              <span className="label-ui text-amber-600" title="Mastodon outbox polling is best-effort — some posts may be missing depending on the instance">BETA</span>
            )}
            {sub.isMuted && <span className="label-ui text-grey-300">MUTED</span>}
          </div>

          {/* Source URI */}
          <p className="text-mono-xs text-grey-400 mt-0.5 truncate">{src.sourceUri}</p>

          {/* Status row */}
          <div className="flex items-center gap-3 mt-1">
            <span className="text-mono-xs text-grey-400">
              {src.itemCount} items
            </span>
            {src.lastFetchedAt && (
              <span className="text-mono-xs text-grey-400">
                Last fetched {formatDateRelative(Math.floor(new Date(src.lastFetchedAt).getTime() / 1000))}
              </span>
            )}
            {isInactive && (
              <span className="text-mono-xs text-crimson">Deactivated</span>
            )}
            {hasError && !isInactive && (
              <span className="text-mono-xs text-crimson">
                {src.errorCount} error{src.errorCount > 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Error detail */}
          {src.lastError && (
            <p className="text-mono-xs text-crimson mt-1 truncate">{src.lastError}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => onRefresh(sub.id)}
            className="btn-text-muted hover:text-black transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={() => onToggleMute(sub.id, sub.isMuted)}
            className="btn-text-muted hover:text-black transition-colors"
          >
            {sub.isMuted ? 'Unmute' : 'Mute'}
          </button>
          {confirmRemove ? (
            <button
              onClick={() => { onRemove(sub.id); setConfirmRemove(false) }}
              className="btn-text-danger"
            >
              Confirm
            </button>
          ) : (
            <button
              onClick={() => {
                setConfirmRemove(true)
                setTimeout(() => setConfirmRemove(false), 3000)
              }}
              className="btn-text-muted hover:text-crimson transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
