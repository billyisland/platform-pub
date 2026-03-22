'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
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

function NotificationRow({ n }: { n: Notification }) {
  const actorName = n.actor?.displayName ?? n.actor?.username ?? 'Someone'
  const articleHref = n.article?.slug ? `/article/${n.article.slug}` : null

  return (
    <div className={`flex items-start gap-3 py-4 border-b border-surface-strong ${!n.read ? 'bg-surface/50' : ''}`}>
      {n.actor?.avatar ? (
        <img src={n.actor.avatar} alt="" className="h-10 w-10 rounded-full object-cover flex-shrink-0 mt-0.5" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center bg-surface-sunken text-sm font-medium text-content-muted rounded-full flex-shrink-0 mt-0.5">
          {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
        </span>
      )}

      <div className="min-w-0 flex-1">
        {n.type === 'new_follower' && (
          <p className="text-sm text-content-primary leading-snug">
            <Link href={n.actor ? `/${n.actor.username}` : '#'} className="font-medium hover:opacity-75 transition-opacity">
              {actorName}
            </Link>
            {' '}followed you
          </p>
        )}

        {n.type === 'new_reply' && (
          <>
            <p className="text-sm text-content-primary leading-snug">
              <Link href={n.actor ? `/${n.actor.username}` : '#'} className="font-medium hover:opacity-75 transition-opacity">
                {actorName}
              </Link>
              {' replied'}
              {n.article?.title && (
                <>
                  {' to '}
                  {articleHref ? (
                    <Link href={articleHref} className="hover:opacity-75 transition-opacity italic">
                      {n.article.title}
                    </Link>
                  ) : (
                    <span className="italic">{n.article.title}</span>
                  )}
                </>
              )}
            </p>
            {n.comment?.content && (
              <p className="text-sm text-content-muted mt-1 line-clamp-2 leading-snug">
                {n.comment.content}
              </p>
            )}
          </>
        )}

        {n.type === 'new_subscriber' && (
          <p className="text-sm text-content-primary leading-snug">
            <Link href={n.actor ? `/${n.actor.username}` : '#'} className="font-medium hover:opacity-75 transition-opacity">
              {actorName}
            </Link>
            {' '}subscribed to your content
          </p>
        )}

        {n.type === 'new_quote' && (
          <p className="text-sm text-content-primary leading-snug">
            <Link href={n.actor ? `/${n.actor.username}` : '#'} className="font-medium hover:opacity-75 transition-opacity">
              {actorName}
            </Link>
            {' '}quoted you
          </p>
        )}

        {n.type === 'new_mention' && (
          <p className="text-sm text-content-primary leading-snug">
            <Link href={n.actor ? `/${n.actor.username}` : '#'} className="font-medium hover:opacity-75 transition-opacity">
              {actorName}
            </Link>
            {' '}mentioned you
          </p>
        )}

        <p className="text-xs text-content-muted mt-1">{timeAgo(n.createdAt)}</p>
      </div>

      {!n.read && (
        <span className="flex-shrink-0 mt-2 h-2 w-2 rounded-full bg-crimson" />
      )}
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
    // Mark as read after a short delay
    const timer = setTimeout(() => {
      notificationsApi.readAll().catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [user])

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article pt-16 lg:pt-0 px-6 py-8">
        <div className="h-7 w-36 animate-pulse bg-surface-sunken mb-2 rounded" />
        <div className="h-4 w-48 animate-pulse bg-surface-sunken mb-8 rounded" />
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
            <div key={i} className="flex items-start gap-3 py-4 border-b border-surface-strong animate-pulse">
              <div className="h-10 w-10 rounded-full bg-surface-sunken flex-shrink-0" />
              <div className="flex-1">
                <div className="h-3.5 w-48 bg-surface-sunken mb-2 rounded" />
                <div className="h-3 w-20 bg-surface-sunken rounded" />
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
            <NotificationRow key={n.id} n={n} />
          ))}
        </div>
      )}
    </div>
  )
}
