'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'
import { notifications as notificationsApi, type Notification } from '../../lib/api'

// =============================================================================
// Notifications Page
//
// Permanent log of all notifications. Unread items render bold with a crimson
// dot; read items stay visible but muted. Older items load in tranches via
// cursor-based pagination.
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
      // Reply to a note — go to the actor's profile
      return n.actor?.username ? `/${n.actor.username}` : '#'
    case 'new_quote':
    case 'new_mention':
      if (n.article?.slug) return `/article/${n.article.slug}`
      // Note-based quote/mention — go to the actor's profile
      return n.actor?.username ? `/${n.actor.username}` : '#'
    case 'commission_request':
    case 'drive_funded':
    case 'pledge_fulfilled':
      return '/dashboard?tab=drives'
    case 'new_message':
      return n.conversationId ? `/messages#${n.conversationId}` : '/messages'
    case 'pub_article_submitted':
    case 'pub_article_published':
      return n.article?.slug ? `/article/${n.article.slug}` : '#'
    case 'pub_invite_received':
      return '/dashboard'
    case 'pub_new_subscriber':
    case 'pub_member_joined':
    case 'pub_member_left':
      return n.actor?.username ? `/${n.actor.username}` : '#'
    default:
      return '#'
  }
}

function NotificationRow({ n, onRead }: { n: Notification; onRead: (id: string, href: string) => void }) {
  const actorName = n.actor?.displayName ?? n.actor?.username ?? 'Someone'
  const destUrl = getDestUrl(n)
  const isUnread = !n.read

  const labels: Partial<Record<Notification['type'], string>> = {
    new_follower: 'followed you',
    new_subscriber: 'subscribed to your content',
    new_quote: 'quoted you',
    new_mention: 'mentioned you',
    commission_request: 'sent you a commission request',
    drive_funded: 'your pledge drive reached its goal',
    pledge_fulfilled: 'a pledge drive you backed was published',
    new_message: 'sent you a message',
    pub_article_submitted: 'submitted an article for review',
    pub_article_published: 'published your article',
    pub_new_subscriber: 'subscribed to your publication',
    pub_invite_received: 'invited you to a publication',
    pub_member_joined: 'joined your publication',
    pub_member_left: 'left your publication',
  }

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => onRead(n.id, destUrl)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onRead(n.id, destUrl) }}
      className={`flex items-start gap-3 px-1 py-4 hover:bg-grey-100/50 transition-colors cursor-pointer ${isUnread ? 'bg-white' : ''}`}
    >
      {n.actor?.avatar ? (
        <img src={n.actor.avatar} alt="" className="h-10 w-10 object-cover flex-shrink-0 mt-0.5" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center bg-grey-100 text-sm font-medium text-grey-400 flex-shrink-0 mt-0.5">
          {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
        </span>
      )}

      <div className="min-w-0 flex-1">
        {n.type === 'new_reply' ? (
          <>
            <p className={`text-sm leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-600'}`}>
              <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>
              {' replied'}
              {n.article?.title && <>{' to '}<span className="italic">{n.article.title}</span></>}
            </p>
            {n.comment?.content && (
              <p className="text-sm text-grey-400 mt-1 line-clamp-2 leading-snug">{n.comment.content}</p>
            )}
          </>
        ) : (
          <p className={`text-sm leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-600'}`}>
            <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>
            {' '}{labels[n.type] ?? 'sent you a notification'}
          </p>
        )}
        <p className="text-xs text-grey-400 mt-1">{timeAgo(n.createdAt)}</p>
      </div>

      {isUnread && (
        <span className="flex-shrink-0 mt-2 h-2 w-2 bg-crimson rounded-full" />
      )}
    </div>
  )
}

export default function NotificationsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const refreshUnread = useUnreadCounts((s) => s.fetch)
  const [items, setItems] = useState<Notification[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  const fetchPage = useCallback(async (cursor?: string) => {
    const isInitial = !cursor
    if (isInitial) setDataLoading(true)
    else setLoadingMore(true)

    try {
      const data = await notificationsApi.list(cursor)
      if (isInitial) {
        setItems(data.notifications)
      } else {
        setItems(prev => {
          const existingIds = new Set(prev.map(n => n.id))
          const unique = data.notifications.filter(n => !existingIds.has(n.id))
          return [...prev, ...unique]
        })
      }
      setNextCursor(data.nextCursor)
    } catch (err) {
      console.error('Failed to load notifications', err)
    } finally {
      setDataLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => { if (user) fetchPage() }, [user, fetchPage])

  async function handleRead(id: string, href: string) {
    // Mark as read locally (bold → normal)
    setItems(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))

    // Persist and refresh badge
    await notificationsApi.markRead(id).catch(err => console.error('Failed to mark notification read', err))
    await refreshUnread()

    if (href !== '#') router.push(href)
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
      <p className="text-ui-sm text-grey-400 mb-8">Your activity log</p>

      {dataLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3 py-4 animate-pulse">
              <div className="h-10 w-10 bg-grey-100 flex-shrink-0" />
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
          <div className="divide-y divide-grey-200/50">
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} onRead={handleRead} />
            ))}
          </div>

          {nextCursor && (
            <div className="py-6 text-center">
              <button
                onClick={() => fetchPage(nextCursor)}
                disabled={loadingMore}
                className="text-sm font-sans text-grey-400 hover:text-black transition-colors"
              >
                {loadingMore ? 'Loading\u2026' : 'Load older notifications'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
