'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { notifications as notificationsApi, type Notification } from '../../lib/api'

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
    case 'commission_request':
    case 'drive_funded':
    case 'pledge_fulfilled':
      return '/dashboard?tab=drives'
    case 'new_message':
      return n.conversationId ? `/messages/${n.conversationId}` : '/messages'
    default:
      return '#'
  }
}

function NotificationItem({ n, onDismiss }: { n: Notification; onDismiss: (id: string, href: string) => void }) {
  const actorName = n.actor?.displayName ?? n.actor?.username ?? 'Someone'
  const destUrl = getDestUrl(n)

  const avatar = n.actor?.avatar ? (
    <img src={n.actor.avatar} alt="" className="h-7 w-7  object-cover flex-shrink-0 mt-0.5" />
  ) : (
    <span className="flex h-7 w-7 items-center justify-center bg-grey-100 text-[10px] font-medium text-grey-400  flex-shrink-0 mt-0.5">
      {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
    </span>
  )

  let body: React.ReactNode

  if (n.type === 'new_follower') {
    body = (
      <>
        <p className="text-xs text-black leading-snug">
          <span className="font-medium">{actorName}</span>{' '}followed you
        </p>
        <p className="text-[12px] text-grey-300 mt-0.5">{timeAgo(n.createdAt)}</p>
      </>
    )
  } else if (n.type === 'new_reply') {
    body = (
      <>
        <p className="text-xs text-black leading-snug">
          <span className="font-medium">{actorName}</span>
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
      dm_payment_required: 'requires payment to message',
      new_user: 'joined the platform',
    }
    const label = simpleLabels[n.type] ?? 'sent you a notification'
    body = (
      <>
        <p className="text-xs text-black leading-snug">
          <span className="font-medium">{actorName}</span>{' '}{label}
        </p>
        <p className="text-[12px] text-grey-300 mt-0.5">{timeAgo(n.createdAt)}</p>
      </>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onDismiss(n.id, destUrl)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onDismiss(n.id, destUrl) }}
      className="block px-4 py-3 border-b-2 border-grey-200/40 last:border-0 hover:bg-grey-100 transition-colors cursor-pointer text-left w-full"
    >
      <div className="flex items-start gap-2.5">
        {avatar}
        <div className="min-w-0">{body}</div>
      </div>
    </div>
  )
}

export function NotificationBell() {
  const router = useRouter()
  const [items, setItems] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dismissedIds = useRef(new Set<string>())

  useEffect(() => {
    notificationsApi.list()
      .then(({ notifications, unreadCount }) => {
        setItems(notifications.filter(n => !dismissedIds.current.has(n.id)))
        setUnreadCount(unreadCount)
      })
      .catch(err => console.error('Failed to load notifications', err))
  }, [])

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
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
      setItems(data.notifications.filter(n => !dismissedIds.current.has(n.id)))
      setUnreadCount(data.notifications.filter(n => !dismissedIds.current.has(n.id)).length)
    } catch {}
    setLoading(false)
  }

  function handleDismiss(id: string, href: string) {
    dismissedIds.current.add(id)
    setItems((prev) => prev.filter((n) => n.id !== id))
    setUnreadCount((prev) => Math.max(0, prev - 1))
    setOpen(false)

    const gateway = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''
    fetch(`${gateway}/api/v1/notifications/${id}/read`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
    })

    router.push(href)
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
          items.map((n) => <NotificationItem key={n.id} n={n} onDismiss={handleDismiss} />)
        )}
      </div>
    </div>
  ) : null

  return (
    <div>
      <button
        ref={buttonRef}
        onClick={handleOpen}
        className="flex items-center gap-2 pl-5 py-[14px] pr-5 border-l-4 border-transparent text-grey-300 font-medium hover:text-grey-600 hover:bg-grey-100 transition-colors w-full"
        title="Notifications"
      >
        <span className="font-sans text-[17px]">Notifications</span>
        {unreadCount > 0 && (
          <span className="font-sans text-sm text-crimson font-medium">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {typeof document !== 'undefined' && panel
        ? createPortal(panel, document.body)
        : null}
    </div>
  )
}
