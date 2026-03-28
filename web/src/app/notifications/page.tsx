'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { notifications as notificationsApi, type Notification } from '../../lib/api'

// =============================================================================
// Notifications Page
//
// Full-page view of notifications. Used on mobile (md and below) where the
// sidebar dropdown is not available. On desktop, the NotificationBell dropdown
// in the nav is the primary surface.
// =============================================================================

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function getDestUrl(n: Notification): string {
  switch (n.type) {
    case 'new_follower':
    case 'new_subscriber':
      return n.actor?.username ? `/${n.actor.username}` : '#'
    case 'new_reply':
      if (n.article?.slug) {
        return n.comment?.id
          ? `/article/${n.article.slug}#reply-${n.comment.id}`
          : `/article/${n.article.slug}`
      }
      return '#'
    case 'new_quote':
    case 'new_mention':
      return n.article?.slug ? `/article/${n.article.slug}` : '#'
    default:
      return '#'
  }
}

function NotificationRow({ n, onDismiss }: { n: Notification; onDismiss: (id: string, href: string) => void }) {
  const actorName = n.actor?.displayName ?? n.actor?.username ?? 'Someone'
  const destUrl = getDestUrl(n)

  const labels: Partial<Record<Notification['type'], string>> = {
    new_follower: 'followed you',
    new_subscriber: 'subscribed to your content',
    new_quote: 'quoted you',
    new_mention: 'mentioned you',
  }

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => onDismiss(n.id, destUrl)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onDismiss(n.id, destUrl) }}
      className="flex items-start gap-3 py-4 border-b border-rule hover:bg-card transition-colors bg-surface/50 cursor-pointer"
    >
      {n.actor?.avatar ? (
        <img src={n.actor.avatar} alt="" className="h-10 w-10 rounded-full object-cover flex-shrink-0 mt-0.5" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center bg-surface-deep text-sm font-medium text-content-muted rounded-full flex-shrink-0 mt-0.5">
          {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
        </span>
      )}

      <div className="min-w-0 flex-1">
        {n.type === 'new_reply' ? (
          <>
            <p className="text-sm text-content-primary leading-snug">
              <span className="font-medium">{actorName}</span>
              {' replied'}
              {n.article?.title && <>{' to '}<span className="italic">{n.article.title}</span></>}
            </p>
            {n.comment?.content && (
              <p className="text-sm text-content-muted mt-1 line-clamp-2 leading-snug">{n.comment.content}</p>
            )}
          </>
        ) : (
          <p className="text-sm text-content-primary leading-snug">
            <span className="font-medium">{actorName}</span>
            {' '}{labels[n.type] ?? n.type}
          </p>
        )}
        <p className="text-xs text-content-muted mt-1">{timeAgo(n.createdAt)}</p>
      </div>

      <span className="flex-shrink-0 mt-2 h-2 w-2 rounded-full bg-accent" />
    </div>
  )
}

export default function NotificationsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [items, setItems] = useState<Notification[]>([])
  const [dataLoading, setDataLoading] = useState(true)

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  useEffect(() => {
    if (!user) return
    notificationsApi.list()
      .then(({ notifications }) => setItems(notifications))
      .catch(() => {})
      .finally(() => setDataLoading(false))
  }, [user])

  async function handleDismiss(id: string, href: string) {
    setItems((prev) => prev.filter((n) => n.id !== id))
    await notificationsApi.markRead(id).catch(() => {})
    router.push(href)
  }

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article pt-16 lg:pt-0 px-6 py-8">
        <div className="h-7 w-36 animate-pulse bg-surface-deep mb-2 rounded" />
        <div className="h-4 w-48 animate-pulse bg-surface-deep mb-8 rounded" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0 px-6 py-8">
      <h1 className="font-serif text-2xl font-normal text-content-primary mb-1">Notifications</h1>
      <p className="text-ui-sm text-content-muted mb-8">Your recent activity</p>

      {dataLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3 py-4 border-b border-rule animate-pulse">
              <div className="h-10 w-10 rounded-full bg-surface-deep flex-shrink-0" />
              <div className="flex-1">
                <div className="h-3.5 w-48 bg-surface-deep mb-2 rounded" />
                <div className="h-3 w-20 bg-surface-deep rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-content-muted">No notifications yet</p>
        </div>
      ) : (
        <div>
          {items.map((n) => (
            <NotificationRow key={n.id} n={n} onDismiss={handleDismiss} />
          ))}
        </div>
      )}
    </div>
  )
}
