'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { useUnreadCounts } from '../../stores/unread'
import { notifications as notificationsApi, type Notification } from '../../lib/api'

// =============================================================================
// NotificationBell — sidebar dropdown (desktop) for quick-glance notifications
//
// Shows the most recent ~10 notifications (read and unread). Unread items are
// bold with a crimson dot. Clicking an unread item marks it read. A "View all"
// link points to the full /notifications log.
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

function NotificationItem({ n, onRead }: { n: Notification; onRead: (id: string, href: string) => void }) {
  const actorName = n.actor?.displayName ?? n.actor?.username ?? 'Someone'
  const destUrl = getDestUrl(n)
  const isUnread = !n.read

  const avatar = n.actor?.avatar ? (
    <img src={n.actor.avatar} alt="" className="h-7 w-7 object-cover flex-shrink-0 mt-0.5" />
  ) : (
    <span className="flex h-7 w-7 items-center justify-center bg-grey-100 text-[10px] font-medium text-grey-400 flex-shrink-0 mt-0.5">
      {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
    </span>
  )

  let body: React.ReactNode

  if (n.type === 'new_follower') {
    body = (
      <>
        <p className={`text-xs leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-500'}`}>
          <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>{' '}followed you
        </p>
        <p className="text-[12px] text-grey-300 mt-0.5">{timeAgo(n.createdAt)}</p>
      </>
    )
  } else if (n.type === 'new_reply') {
    body = (
      <>
        <p className={`text-xs leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-500'}`}>
          <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>
          {' replied'}
          {n.article?.title && <>{' to '}<span className="italic">{n.article.title}</span></>}
        </p>
        {n.comment?.content && (
          <p className="text-[12px] text-grey-300 mt-1 line-clamp-2 leading-snug">{n.comment.content}</p>
        )}
        <p className="text-[12px] text-grey-300 mt-0.5">{timeAgo(n.createdAt)}</p>
      </>
    )
  } else {
    const simpleLabels: Partial<Record<Notification['type'], string>> = {
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
    const label = simpleLabels[n.type] ?? 'sent you a notification'
    body = (
      <>
        <p className={`text-xs leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-500'}`}>
          <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>{' '}{label}
        </p>
        <p className="text-[12px] text-grey-300 mt-0.5">{timeAgo(n.createdAt)}</p>
      </>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onRead(n.id, destUrl)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onRead(n.id, destUrl) }}
      className="block px-4 py-3 border-b-2 border-grey-200/40 last:border-0 hover:bg-grey-100 transition-colors cursor-pointer text-left w-full"
    >
      <div className="flex items-start gap-2.5">
        {avatar}
        <div className="min-w-0 flex-1">{body}</div>
        {isUnread && (
          <span className="flex-shrink-0 mt-1.5 h-1.5 w-1.5 bg-crimson rounded-full" />
        )}
      </div>
    </div>
  )
}

export function NotificationBell() {
  const router = useRouter()
  const notificationCount = useUnreadCounts((s) => s.notificationCount)
  const refreshUnread = useUnreadCounts((s) => s.fetch)
  const [items, setItems] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  async function handleOpen() {
    if (open) {
      setOpen(false)
      return
    }
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setPanelStyle({
        position: 'fixed',
        top: rect.top,
        left: rect.right + 8,
        zIndex: 9999,
        width: 320,
        maxHeight: 480,
      })
    }
    setOpen(true)
    setLoading(true)
    try {
      const data = await notificationsApi.list()
      // Show the most recent 10 in the dropdown
      setItems(data.notifications.slice(0, 10))
    } catch {}
    setLoading(false)
  }

  async function handleRead(id: string, href: string) {
    // Mark as read locally (bold → normal)
    setItems(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
    setOpen(false)

    // Persist and refresh badge
    notificationsApi.markRead(id).catch(() => {})
    refreshUnread()

    if (href !== '#') router.push(href)
  }

  const panel = open ? (
    <div
      ref={panelRef}
      style={panelStyle}
      className="bg-white border border-grey-200 shadow-xl overflow-hidden flex flex-col"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b-2 border-grey-200/40 flex-shrink-0">
        <span className="font-sans text-sm font-medium text-black">Notifications</span>
        {loading && (
          <span className="text-[12px] text-grey-300">Loading…</span>
        )}
      </div>

      <div className="overflow-y-auto flex-1">
        {items.length === 0 && !loading ? (
          <p className="px-4 py-8 text-center text-xs text-grey-300">No notifications yet</p>
        ) : (
          items.map((n) => <NotificationItem key={n.id} n={n} onRead={handleRead} />)
        )}
      </div>

      <div className="border-t border-grey-200/40 px-4 py-2.5 flex-shrink-0">
        <button
          onClick={() => { setOpen(false); router.push('/notifications') }}
          className="text-[12px] font-sans text-grey-400 hover:text-black transition-colors w-full text-center"
        >
          View all notifications
        </button>
      </div>
    </div>
  ) : null

  return (
    <div>
      <button
        ref={buttonRef}
        onClick={handleOpen}
        aria-expanded={open}
        className="flex items-center gap-2 pl-5 py-[14px] pr-5 border-l-4 border-transparent text-grey-300 font-medium hover:text-grey-600 hover:bg-grey-100 transition-colors w-full"
        title="Notifications"
      >
        <span className="font-sans text-[17px]">Notifications</span>
        {notificationCount > 0 && (
          <span className="font-sans text-sm text-crimson font-medium">
            {notificationCount > 99 ? '99+' : notificationCount}
          </span>
        )}
      </button>

      {typeof document !== 'undefined' && panel
        ? createPortal(panel, document.body)
        : null}
    </div>
  )
}
