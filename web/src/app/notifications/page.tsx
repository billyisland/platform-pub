'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'
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
    commission_request: 'sent you a commission request',
    drive_funded: 'your pledge drive reached its goal',
    pledge_fulfilled: 'a pledge drive you backed was published',
    new_message: 'sent you a message',
    dm_payment_required: 'requires payment to message',
    new_user: 'joined the platform',
  }

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => onDismiss(n.id, destUrl)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onDismiss(n.id, destUrl) }}
      className="flex items-start gap-3 py-4 hover:bg-white transition-colors bg-white/50 cursor-pointer"
    >
      {n.actor?.avatar ? (
        <img src={n.actor.avatar} alt="" className="h-10 w-10  object-cover flex-shrink-0 mt-0.5" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center bg-grey-100 text-sm font-medium text-grey-400  flex-shrink-0 mt-0.5">
          {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
        </span>
      )}

      <div className="min-w-0 flex-1">
        {n.type === 'new_reply' ? (
          <>
            <p className="text-sm text-black leading-snug">
              <span className="font-medium">{actorName}</span>
              {' replied'}
              {n.article?.title && <>{' to '}<span className="italic">{n.article.title}</span></>}
            </p>
            {n.comment?.content && (
              <p className="text-sm text-grey-400 mt-1 line-clamp-2 leading-snug">{n.comment.content}</p>
            )}
          </>
        ) : (
          <p className="text-sm text-black leading-snug">
            <span className="font-medium">{actorName}</span>
            {' '}{labels[n.type] ?? 'sent you a notification'}
          </p>
        )}
        <p className="text-xs text-grey-400 mt-1">{timeAgo(n.createdAt)}</p>
      </div>

      <span className="flex-shrink-0 mt-2 h-2 w-2  bg-crimson" />
    </div>
  )
}

export default function NotificationsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const refreshUnread = useUnreadCounts((s) => s.fetch)
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
    refreshUnread()
    router.push(href)
  }

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article pt-16 lg:pt-0 px-4 sm:px-6 py-8">
        <div className="h-7 w-36 animate-pulse bg-grey-100 mb-2 rounded" />
        <div className="h-4 w-48 animate-pulse bg-grey-100 mb-8 rounded" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0 px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl sm:text-4xl font-light text-black mb-1">Notifications</h1>
      <p className="text-ui-sm text-grey-400 mb-8">Your recent activity</p>

      {dataLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3 py-4 animate-pulse">
              <div className="h-10 w-10  bg-grey-100 flex-shrink-0" />
              <div className="flex-1">
                <div className="h-3.5 w-48 bg-grey-100 mb-2 rounded" />
                <div className="h-3 w-20 bg-grey-100 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-400">No notifications yet</p>
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
