'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { notifications as notificationsApi, type Notification } from '../../lib/api'
import { useUnreadCounts } from '../../stores/unread'

const TOKENS = {
  panelBg: '#FFFFFF',
  panelBorder: '#1A1A18',
  rowHoverBg: '#F0EFEB',
  unreadDot: '#B5242A',
  unreadBg: '#FAFAF7',
  meta: '#8A8880',
  text: '#1A1A18',
  hint: '#9C9A94',
}

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
      return '/workspace?overlay=dashboard&tab=proposals'
    case 'pub_article_submitted':
    case 'pub_article_published':
      return n.article?.slug ? `/article/${n.article.slug}` : '#'
    case 'pub_invite_received':
      return '/workspace?overlay=dashboard'
    case 'pub_new_subscriber':
    case 'pub_member_joined':
    case 'pub_member_left':
      return n.actor?.username ? `/${n.actor.username}` : '#'
    default:
      return '#'
  }
}

/**
 * Notifications dialog body, opened in place from the ∀ dock menu. Owns its
 * list/data; the badge count lives on the shared `useUnreadCounts` store
 * (globally polled in AuthProvider), which this panel refreshes after any
 * mark-read mutation so the ∀ badge stays in sync.
 */
export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const refreshUnread = useUnreadCounts((s) => s.fetch)
  const [items, setItems] = useState<Notification[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const loadList = useCallback(async () => {
    setStatus('loading')
    try {
      const data = await notificationsApi.list()
      setItems(data.notifications)
      setStatus('ready')
    } catch (err) {
      console.error('Notifications load error:', err)
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const hasUnread = items.some((x) => !x.read)

  async function handleRowClick(n: Notification) {
    const href = destUrl(n)
    // Optimistic mark-read, then sync the shared badge count.
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)))
    notificationsApi
      .markRead(n.id)
      .then(() => refreshUnread())
      .catch((err) => {
        console.error('Mark-read failed:', err)
      })
    onClose()
    if (href !== '#') router.push(href)
  }

  async function handleReadAll() {
    if (!hasUnread) return
    setItems((prev) => prev.map((x) => ({ ...x, read: true })))
    try {
      await notificationsApi.readAll()
      void refreshUnread()
    } catch (err) {
      console.error('Read-all failed:', err)
      // Reload to recover from drift.
      void loadList()
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Notifications"
      style={{
        position: 'absolute',
        right: 0,
        bottom: 72,
        width: 380,
        maxHeight: 'min(560px, calc(100vh - 120px))',
        background: TOKENS.panelBg,
        border: `2px solid ${TOKENS.panelBorder}`,
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
        }}
      >
        <span className="label-ui" style={{ color: TOKENS.text }}>
          Notifications
        </span>
        <button
          type="button"
          onClick={handleReadAll}
          disabled={!hasUnread}
          className="label-ui"
          style={{
            background: 'transparent',
            border: 'none',
            color: hasUnread ? TOKENS.text : TOKENS.hint,
            cursor: hasUnread ? 'pointer' : 'default',
            padding: 0,
          }}
        >
          Mark all read
        </button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {status === 'loading' && (
          <div
            className="label-ui"
            style={{ color: TOKENS.hint, padding: '24px 16px', textAlign: 'center' }}
          >
            Loading…
          </div>
        )}
        {status === 'error' && (
          <div
            className="label-ui"
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
        {status === 'ready' &&
          items.map((n) => {
            const actorName = n.actor?.displayName ?? n.actor?.username ?? 'Someone'
            const isUnread = !n.read
            const label =
              n.type === 'new_reply'
                ? n.article?.title
                  ? `replied to ${n.article.title}`
                  : 'replied to your note'
                : TYPE_LABELS[n.type] ?? 'sent you a notification'
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
                    className="font-sans text-ui-xs"
                    style={{
                      color: TOKENS.text,
                      fontWeight: isUnread ? 600 : 400,
                      lineHeight: 1.4,
                    }}
                  >
                    <span style={{ fontWeight: isUnread ? 600 : 500 }}>{actorName}</span>{' '}
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
            textAlign: 'right',
          }}
        >
          <button
            type="button"
            onClick={() => {
              onClose()
              router.push('/notifications')
            }}
            className="label-ui"
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
  )
}
