'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { notifications as notificationsApi, type Notification } from '../../lib/api'

// =============================================================================
// NotificationBell
//
// Bell icon that shows an unread count badge. Clicking opens a dropdown panel
// with the 50 most recent notifications. Opening the panel marks all as read.
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

function NotificationItem({ n }: { n: Notification }) {
  const actorName = n.actor?.displayName ?? n.actor?.username ?? 'Someone'

  if (n.type === 'new_follower') {
    return (
      <div className={`px-4 py-3 border-b border-ink-800 last:border-0 ${!n.read ? 'bg-white/5' : ''}`}>
        <div className="flex items-start gap-2.5">
          {n.actor?.avatar ? (
            <img src={n.actor.avatar} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0 mt-0.5" />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center bg-ink-800 text-[10px] font-medium text-surface-raised rounded-full flex-shrink-0 mt-0.5">
              {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="text-xs text-surface-raised leading-snug">
              <Link href={n.actor ? `/${n.actor.username}` : '#'} className="font-medium hover:text-white transition-colors">
                {actorName}
              </Link>
              {' '}followed you
            </p>
            <p className="text-[11px] text-ink-400 mt-0.5">{timeAgo(n.createdAt)}</p>
          </div>
        </div>
      </div>
    )
  }

  if (n.type === 'new_reply') {
    const articleHref = n.article?.slug ? `/article/${n.article.slug}` : null
    return (
      <div className={`px-4 py-3 border-b border-ink-800 last:border-0 ${!n.read ? 'bg-white/5' : ''}`}>
        <div className="flex items-start gap-2.5">
          {n.actor?.avatar ? (
            <img src={n.actor.avatar} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0 mt-0.5" />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center bg-ink-800 text-[10px] font-medium text-surface-raised rounded-full flex-shrink-0 mt-0.5">
              {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="text-xs text-surface-raised leading-snug">
              <Link href={n.actor ? `/${n.actor.username}` : '#'} className="font-medium hover:text-white transition-colors">
                {actorName}
              </Link>
              {' replied'}
              {n.article?.title ? (
                <>
                  {' to '}
                  {articleHref ? (
                    <Link href={articleHref} className="hover:text-white transition-colors italic">
                      {n.article.title}
                    </Link>
                  ) : (
                    <span className="italic">{n.article.title}</span>
                  )}
                </>
              ) : ' to your post'}
            </p>
            {n.comment?.content && (
              <p className="text-[11px] text-ink-400 mt-1 line-clamp-2 leading-snug">
                {n.comment.content}
              </p>
            )}
            <p className="text-[11px] text-ink-400 mt-0.5">{timeAgo(n.createdAt)}</p>
          </div>
        </div>
      </div>
    )
  }

  const simpleTypes: Partial<Record<Notification['type'], string>> = {
    new_subscriber: 'subscribed to your content',
    new_quote: 'quoted you',
    new_mention: 'mentioned you',
  }

  if (n.type in simpleTypes) {
    return (
      <div className={`px-4 py-3 border-b border-ink-800 last:border-0 ${!n.read ? 'bg-white/5' : ''}`}>
        <div className="flex items-start gap-2.5">
          {n.actor?.avatar ? (
            <img src={n.actor.avatar} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0 mt-0.5" />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center bg-ink-800 text-[10px] font-medium text-surface-raised rounded-full flex-shrink-0 mt-0.5">
              {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="text-xs text-surface-raised leading-snug">
              <Link href={n.actor ? `/${n.actor.username}` : '#'} className="font-medium hover:text-white transition-colors">
                {actorName}
              </Link>
              {' '}{simpleTypes[n.type]}
            </p>
            <p className="text-[11px] text-ink-400 mt-0.5">{timeAgo(n.createdAt)}</p>
          </div>
        </div>
      </div>
    )
  }

  return null
}

export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Fetch on mount
  useEffect(() => {
    notificationsApi.list()
      .then(({ notifications, unreadCount }) => {
        setItems(notifications)
        setUnreadCount(unreadCount)
      })
      .catch(() => {})
  }, [])

  // Close on outside click
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
    // Position the portal panel next to the button
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
    // Refresh the list
    setLoading(true)
    try {
      const data = await notificationsApi.list()
      setItems(data.notifications)
      setUnreadCount(data.unreadCount)
    } catch {}
    setLoading(false)
    // Mark as read
    if (unreadCount > 0) {
      notificationsApi.readAll()
        .then(() => {
          setUnreadCount(0)
          setItems((prev) => prev.map((n) => ({ ...n, read: true })))
        })
        .catch(() => {})
    }
  }

  const panel = open ? (
    <div
      ref={panelRef}
      style={panelStyle}
      className="bg-ink-900 border border-ink-800 shadow-xl overflow-hidden flex flex-col"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-800 flex-shrink-0">
        <span className="font-serif text-sm font-medium text-surface-raised">Notifications</span>
        {loading && (
          <span className="text-[11px] text-ink-400">Loading…</span>
        )}
      </div>

      <div className="overflow-y-auto flex-1">
        {items.length === 0 && !loading ? (
          <p className="px-4 py-8 text-center text-xs text-ink-400">No notifications yet</p>
        ) : (
          items.map((n) => <NotificationItem key={n.id} n={n} />)
        )}
      </div>
    </div>
  ) : null

  return (
    <div>
      {/* Notifications button */}
      <button
        ref={buttonRef}
        onClick={handleOpen}
        className="flex items-center gap-2 pl-4 py-2.5 text-ink-400 hover:bg-white/5 hover:text-white transition-colors w-full"
        title="Notifications"
      >
        <span className="font-serif text-sm">Notifications</span>
        {unreadCount > 0 && (
          <span className="font-serif text-sm text-crimson font-medium">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel — rendered via portal to escape overflow:hidden */}
      {typeof document !== 'undefined' && panel
        ? createPortal(panel, document.body)
        : null}
    </div>
  )
}
