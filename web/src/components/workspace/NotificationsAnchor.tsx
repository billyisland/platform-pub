'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { notifications as notificationsApi, type Notification } from '../../lib/api'

const TOKENS = {
  buttonBg: '#FFFFFF',
  buttonFg: '#1A1A18',
  buttonRing: '#1A1A18',
  buttonHoverBg: '#F0EFEB',
  badgeBg: '#B5242A',
  badgeFg: '#FFFFFF',
  panelBg: '#FFFFFF',
  panelBorder: '#1A1A18',
  rowHoverBg: '#F0EFEB',
  unreadDot: '#B5242A',
  unreadBg: '#FAFAF7',
  meta: '#8A8880',
  text: '#1A1A18',
  hint: '#9C9A94',
  hairline: 'rgba(26, 26, 24, 0.08)',
}

const POLL_INTERVAL_MS = 30_000

const TYPE_LABELS: Partial<Record<Notification['type'], string>> = {
  new_follower: 'followed you',
  new_subscriber: 'subscribed to your content',
  new_quote: 'quoted you',
  new_mention: 'mentioned you',
  commission_request: 'sent a commission request',
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

function destUrl(n: Notification): string {
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
      return n.actor?.username ? `/${n.actor.username}` : '#'
    case 'new_quote':
    case 'new_mention':
      if (n.article?.slug) return `/article/${n.article.slug}`
      return n.actor?.username ? `/${n.actor.username}` : '#'
    case 'commission_request':
    case 'drive_funded':
    case 'pledge_fulfilled':
      return '/dashboard?tab=proposals'
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

export function NotificationsAnchor() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [items, setItems] = useState<Notification[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const refreshCount = useCallback(async () => {
    try {
      const data = await notificationsApi.unreadCounts()
      setUnreadCount(data.notificationCount)
    } catch {
      // Network blip — keep last known count rather than zeroing.
    }
  }, [])

  const loadList = useCallback(async () => {
    setStatus('loading')
    try {
      const data = await notificationsApi.list()
      setItems(data.notifications)
      setUnreadCount(data.unreadCount)
      setStatus('ready')
    } catch (err) {
      console.error('Notifications load error:', err)
      setStatus('error')
    }
  }, [])

  // Initial badge fetch + polling. Stays running whether the panel is open or
  // closed — the cost is one cheap COUNT query every 30s. ADR-level user
  // memory: real-time push is mobile-app territory; web stays on polling.
  useEffect(() => {
    void refreshCount()
    const id = window.setInterval(() => {
      void refreshCount()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [refreshCount])

  // Refetch the visible list whenever the panel opens so the user always sees
  // the freshest state. Closing the panel doesn't drop the cached list — a
  // quick reopen feels instant.
  useEffect(() => {
    if (open) void loadList()
  }, [open, loadList])

  // Outside click + Esc close. Mirrors ForallMenu's pattern.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (buttonRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function handleRowClick(n: Notification) {
    const href = destUrl(n)
    // Optimistic mark-read.
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)))
    if (!n.read) setUnreadCount((c) => Math.max(0, c - 1))
    notificationsApi.markRead(n.id).catch((err) => {
      console.error('Mark-read failed:', err)
    })
    setOpen(false)
    if (href !== '#') router.push(href)
  }

  async function handleReadAll() {
    if (unreadCount === 0) return
    setItems((prev) => prev.map((x) => ({ ...x, read: true })))
    setUnreadCount(0)
    try {
      await notificationsApi.readAll()
    } catch (err) {
      console.error('Read-all failed:', err)
      // Reload to recover from drift.
      void loadList()
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 96, // ∀ sits at right: 24 with width 56; gap 16; bell width 40 + 16 padding
        bottom: 32, // bell is 40px vs ∀'s 56px — vertical-centre to ∀'s axis
        zIndex: 50,
      }}
    >
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          style={{
            position: 'absolute',
            right: 0,
            bottom: 56,
            width: 380,
            maxHeight: 'min(560px, calc(100vh - 120px))',
            background: TOKENS.panelBg,
            border: `1px solid ${TOKENS.panelBorder}`,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              padding: '14px 16px 10px 16px',
              borderBottom: `1px solid ${TOKENS.hairline}`,
            }}
          >
            <span
              className="font-mono text-[11px] uppercase tracking-[0.06em]"
              style={{ color: TOKENS.text }}
            >
              Notifications
            </span>
            <button
              type="button"
              onClick={handleReadAll}
              disabled={unreadCount === 0}
              className="font-mono text-[11px] uppercase tracking-[0.06em]"
              style={{
                background: 'transparent',
                border: 'none',
                color: unreadCount === 0 ? TOKENS.hint : TOKENS.text,
                cursor: unreadCount === 0 ? 'default' : 'pointer',
                padding: 0,
              }}
            >
              Mark all read
            </button>
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {status === 'loading' && (
              <div
                className="font-mono text-[11px] uppercase tracking-[0.06em]"
                style={{ color: TOKENS.hint, padding: '24px 16px', textAlign: 'center' }}
              >
                Loading…
              </div>
            )}
            {status === 'error' && (
              <div
                className="font-mono text-[11px] uppercase tracking-[0.06em]"
                style={{ color: TOKENS.hint, padding: '24px 16px', textAlign: 'center' }}
              >
                Couldn’t load notifications
              </div>
            )}
            {status === 'ready' && items.length === 0 && (
              <div
                style={{
                  color: TOKENS.hint,
                  padding: '32px 16px',
                  textAlign: 'center',
                  fontStyle: 'italic',
                }}
                className="font-serif text-[13px]"
              >
                Nothing here yet.
              </div>
            )}
            {status === 'ready' && items.map((n) => {
              const actorName = n.actor?.displayName ?? n.actor?.username ?? 'Someone'
              const isUnread = !n.read
              const label = n.type === 'new_reply'
                ? (n.article?.title ? `replied to ${n.article.title}` : 'replied to your note')
                : (TYPE_LABELS[n.type] ?? 'sent you a notification')
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleRowClick(n)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    width: '100%',
                    textAlign: 'left',
                    padding: '12px 16px',
                    background: isUnread ? TOKENS.unreadBg : 'transparent',
                    border: 'none',
                    borderBottom: `1px solid ${TOKENS.hairline}`,
                    cursor: 'pointer',
                    transition: 'background 80ms linear',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = TOKENS.rowHoverBg
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isUnread ? TOKENS.unreadBg : 'transparent'
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      flexShrink: 0,
                      marginTop: 6,
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: isUnread ? TOKENS.unreadDot : 'transparent',
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      className="font-sans text-[13px]"
                      style={{
                        color: TOKENS.text,
                        fontWeight: isUnread ? 600 : 400,
                        lineHeight: 1.4,
                      }}
                    >
                      <span style={{ fontWeight: isUnread ? 600 : 500 }}>{actorName}</span>
                      {' '}
                      <span style={{ fontWeight: 400, color: isUnread ? TOKENS.text : TOKENS.meta }}>
                        {label}
                      </span>
                    </div>
                    {n.type === 'new_reply' && n.comment?.content && (
                      <div
                        className="font-serif text-[13px]"
                        style={{
                          color: TOKENS.meta,
                          marginTop: 2,
                          fontStyle: 'italic',
                          overflow: 'hidden',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          lineHeight: 1.4,
                        }}
                      >
                        {n.comment.content}
                      </div>
                    )}
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.06em]"
                      style={{ color: TOKENS.hint, marginTop: 4 }}
                    >
                      {timeAgo(n.createdAt)}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {status === 'ready' && items.length > 0 && (
            <div
              style={{
                padding: '10px 16px',
                borderTop: `1px solid ${TOKENS.hairline}`,
                textAlign: 'right',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  router.push('/notifications')
                }}
                className="font-mono text-[11px] uppercase tracking-[0.06em]"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: TOKENS.text,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                Open full log ›
              </button>
            </div>
          )}
        </div>
      )}

      <button
        ref={buttonRef}
        type="button"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'relative',
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: TOKENS.buttonBg,
          color: TOKENS.buttonFg,
          border: `1px solid ${TOKENS.buttonRing}`,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.10)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'transform 120ms ease-out, background 120ms ease-out',
          transform: open ? 'scale(1.04)' : 'scale(1)',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = TOKENS.buttonHoverBg
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = TOKENS.buttonBg
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 7a5 5 0 0 1 10 0v3l1.4 2.4a.5.5 0 0 1-.43.75H3.03a.5.5 0 0 1-.43-.75L4 10z" />
          <path d="M7.5 14.5a1.6 1.6 0 0 0 3 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="font-mono"
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 9,
              background: TOKENS.badgeBg,
              color: TOKENS.badgeFg,
              fontSize: 10,
              fontWeight: 600,
              lineHeight: '18px',
              textAlign: 'center',
              border: `1px solid ${TOKENS.panelBg}`,
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
    </div>
  )
}
