'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { writers, type WriterProfile } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import Link from 'next/link'
import { ArticleCard } from '../../components/feed/ArticleCard'
import { NoteCard } from '../../components/feed/NoteCard'
import { NoteComposer } from '../../components/feed/NoteComposer'
import type { ArticleEvent, NoteEvent } from '../../lib/ndk'
import type { QuoteTarget } from '../../lib/publishNote'

interface DbArticle {
  id: string
  nostrEventId: string
  dTag: string
  title: string
  slug: string
  summary: string | null
  wordCount: number | null
  isPaywalled: boolean
  publishedAt: string | null
}

interface DbNote {
  id: string
  nostrEventId: string
  content: string
  publishedAt: string
}

interface DbReply {
  id: string
  nostrEventId: string
  content: string
  publishedAt: string
  articleSlug: string | null
  articleTitle: string | null
}

type ActivityItem =
  | { kind: 'article'; publishedAt: string; data: DbArticle }
  | { kind: 'note'; publishedAt: string; data: DbNote }
  | { kind: 'reply'; publishedAt: string; data: DbReply }

interface SubStatus {
  subscribed: boolean
  ownContent?: boolean
  status?: string
  pricePence?: number
  currentPeriodEnd?: string
}

export default function WriterProfilePage() {
  const params = useParams()
  const username = params.username as string
  const { user, loading: authLoading } = useAuth()
  const [writer, setWriter] = useState<WriterProfile | null>(null)
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [profileError, setProfileError] = useState(false)
  const [following, setFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [subStatus, setSubStatus] = useState<SubStatus | null>(null)
  const [subLoading, setSubLoading] = useState(false)
  const [pendingQuote, setPendingQuote] = useState<QuoteTarget | null>(null)

  // Load profile, articles, notes, and replies
  useEffect(() => {
    async function loadProfile() {
      setLoading(true)
      try {
        const writerData = await writers.getProfile(username)
        setWriter(writerData)
        const [articlesRes, notesRes, repliesRes] = await Promise.all([
          fetch(`/api/v1/writers/${username}/articles?limit=50`, { credentials: 'include' }),
          fetch(`/api/v1/writers/${username}/notes?limit=50`, { credentials: 'include' }),
          fetch(`/api/v1/writers/${username}/replies?limit=50`, { credentials: 'include' }),
        ])
        const items: ActivityItem[] = []
        if (articlesRes.ok) {
          const data = await articlesRes.json()
          for (const a of (data.articles ?? []) as DbArticle[]) {
            if (a.publishedAt) items.push({ kind: 'article', publishedAt: a.publishedAt, data: a })
          }
        }
        if (notesRes.ok) {
          const data = await notesRes.json()
          for (const n of (data.notes ?? []) as DbNote[]) {
            items.push({ kind: 'note', publishedAt: n.publishedAt, data: n })
          }
        }
        if (repliesRes.ok) {
          const data = await repliesRes.json()
          for (const r of (data.replies ?? []) as DbReply[]) {
            items.push({ kind: 'reply', publishedAt: r.publishedAt, data: r })
          }
        }
        items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
        setActivity(items)
      } catch (err: any) {
        if (err.status === 404) setNotFound(true)
        else setProfileError(true)
      } finally { setLoading(false) }
    }
    if (username) loadProfile()
  }, [username])

  // Check follow + subscription status
  useEffect(() => {
    if (!user || !writer) return
    async function checkStatus() {
      try {
        const [followRes, subRes] = await Promise.all([
          fetch('/api/v1/follows', { credentials: 'include' }),
          fetch(`/api/v1/subscriptions/check/${writer!.id}`, { credentials: 'include' }),
        ])
        if (followRes.ok) {
          const data = await followRes.json()
          setFollowing((data.writers ?? []).some((w: any) => w.id === writer!.id))
        }
        if (subRes.ok) {
          setSubStatus(await subRes.json())
        }
      } catch { setSubStatus({ subscribed: false }) }
    }
    checkStatus()
  }, [user, writer])

  async function handleToggleFollow() {
    if (!user || !writer) return
    setFollowLoading(true)
    try {
      const res = await fetch(`/api/v1/follows/${writer.id}`, {
        method: following ? 'DELETE' : 'POST',
        credentials: 'include',
      })
      if (res.ok) setFollowing(!following)
    } catch (err) { console.error('Follow error:', err) }
    finally { setFollowLoading(false) }
  }

  async function handleSubscribe() {
    if (!user || !writer) return
    setSubLoading(true)
    try {
      const res = await fetch(`/api/v1/subscriptions/${writer.id}`, {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok) {
        const data = await res.json()
        setSubStatus({ subscribed: true, status: 'active', pricePence: data.pricePence, currentPeriodEnd: data.currentPeriodEnd })
      }
    } catch (err) { console.error('Subscribe error:', err) }
    finally { setSubLoading(false) }
  }

  async function handleUnsubscribe() {
    if (!user || !writer) return
    setSubLoading(true)
    try {
      const res = await fetch(`/api/v1/subscriptions/${writer.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) {
        const data = await res.json()
        setSubStatus({ subscribed: true, status: 'cancelled', currentPeriodEnd: data.accessUntil })
      }
    } catch (err) { console.error('Unsubscribe error:', err) }
    finally { setSubLoading(false) }
  }

  const handleNoteDeleted = useCallback((id: string) => {
    setActivity(prev => prev.filter(i => !(i.kind === 'note' && (i.data as DbNote).nostrEventId === id)))
  }, [])

  const handleQuote = useCallback((target: QuoteTarget) => {
    setPendingQuote(target)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const isOwnProfile = user?.username === username
  const articleCount = activity.filter(i => i.kind === 'article').length
  const hasPaywalledArticles = activity.some(i => i.kind === 'article' && (i.data as DbArticle).isPaywalled)

  if (loading) {
    return (
      <div className="mx-auto max-w-article px-6 py-12">
        <div className="flex items-center gap-4 mb-12">
          <div className="h-14 w-14 animate-pulse bg-surface-raised" />
          <div><div className="h-6 w-36 animate-pulse bg-surface-raised mb-2" /><div className="h-3 w-20 animate-pulse bg-surface-raised" /></div>
        </div>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-article px-6 py-28 text-center">
        <h1 className="font-serif text-2xl font-light text-ink-900 mb-2">User not found</h1>
        <p className="text-ui-sm text-content-muted">No user with the username @{username} exists on Platform.</p>
      </div>
    )
  }

  if (profileError) {
    return (
      <div className="mx-auto max-w-article px-6 py-28 text-center">
        <p className="text-ui-sm text-content-muted">Something went wrong loading this profile. Please try again.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-article px-6 py-12">
      <div className="mb-12">
        <div className="flex items-center gap-4 mb-4">
          {writer?.avatar ? (
            <img src={writer.avatar} alt="" className="h-14 w-14 rounded-full object-cover" />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center bg-surface-sunken text-lg font-medium text-content-primary rounded-full">
              {(writer?.displayName ?? username)[0].toUpperCase()}
            </span>
          )}
          <div className="flex-1">
            <h1 className="font-serif text-2xl font-light text-ink-900 tracking-tight">{writer?.displayName ?? username}</h1>
            <p className="text-ui-xs text-content-faint mt-0.5">@{username}</p>
          </div>

          {/* Action buttons — logged-in non-owner */}
          {user && !isOwnProfile && writer && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleToggleFollow}
                disabled={followLoading}
                className={`transition-colors disabled:opacity-50 ${following ? 'btn-soft py-1.5 px-4 text-ui-xs' : 'btn py-1.5 px-4 text-ui-xs'}`}
              >
                {followLoading ? '...' : following ? 'Following' : 'Follow'}
              </button>

              {hasPaywalledArticles && subStatus && !subStatus.ownContent && (
                subStatus.subscribed ? (
                  <button
                    onClick={handleUnsubscribe}
                    disabled={subLoading}
                    className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
                  >
                    {subLoading ? '...' : subStatus.status === 'cancelled'
                      ? `Access until ${new Date(subStatus.currentPeriodEnd!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                      : 'Subscribed'}
                  </button>
                ) : (
                  <button
                    onClick={handleSubscribe}
                    disabled={subLoading}
                    className="btn-accent py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
                  >
                    {subLoading ? '...' : `Subscribe £${((subStatus.pricePence ?? writer.subscriptionPricePence ?? 500) / 100).toFixed(2)}/mo`}
                  </button>
                )
              )}
            </div>
          )}

          {/* Log in prompt for anonymous visitors */}
          {!user && !authLoading && writer && !isOwnProfile && (
            <Link href="/auth?mode=login" className="text-ui-xs text-content-muted hover:text-content-primary transition-colors">
              Log in to follow
            </Link>
          )}
        </div>

        {writer?.bio && (
          <p className="font-serif text-sm text-content-secondary leading-relaxed max-w-lg" style={{ lineHeight: '1.7' }}>{writer.bio}</p>
        )}
        <p className="mt-4 text-ui-xs text-content-faint">
          {articleCount} article{articleCount !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="rule mb-10" />

      {/* Quote composer modal */}
      {pendingQuote && (
        <div
          className="fixed inset-0 z-50 bg-ink-900/60 flex items-center justify-center p-4"
          onClick={() => setPendingQuote(null)}
        >
          <div className="w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <NoteComposer
              quoteTarget={pendingQuote}
              onPublished={() => setPendingQuote(null)}
              onClearQuote={() => setPendingQuote(null)}
            />
          </div>
        </div>
      )}

      {activity.length === 0 ? (
        <p className="text-ui-sm text-content-muted py-10">Looks like {writer?.displayName ?? username} hasn't said anything yet.</p>
      ) : (
        <div className="space-y-3" style={{ background: 'rgb(234,229,220)' }}>
          {activity.map(item => {
            if (item.kind === 'article') {
              const a = item.data as DbArticle
              const articleEvent: ArticleEvent & { type: 'article' } = {
                type: 'article',
                id: a.nostrEventId,
                pubkey: writer!.pubkey,
                dTag: a.dTag,
                title: a.title,
                summary: a.summary ?? '',
                content: '',
                publishedAt: a.publishedAt ? Math.floor(new Date(a.publishedAt).getTime() / 1000) : 0,
                tags: [],
                isPaywalled: a.isPaywalled,
              }
              return <ArticleCard key={a.id} article={articleEvent} onQuote={handleQuote} />
            }
            if (item.kind === 'note') {
              const n = item.data as DbNote
              const noteEvent: NoteEvent = {
                type: 'note',
                id: n.nostrEventId,
                pubkey: writer!.pubkey,
                content: n.content,
                publishedAt: Math.floor(new Date(n.publishedAt).getTime() / 1000),
              }
              return <NoteCard key={n.id} note={noteEvent} onDeleted={handleNoteDeleted} onQuote={handleQuote} />
            }
            return <DbReplyCard key={item.data.id} reply={item.data as DbReply} writerName={writer?.displayName ?? username} />
          })}
        </div>
      )}
    </div>
  )
}

function DbReplyCard({ reply, writerName }: { reply: DbReply; writerName: string }) {
  return (
    <div className="bg-surface-raised p-5 border-l-[3px] border-surface-strong opacity-80">
      <p className="label-ui text-content-muted mb-3">{writerName} · Reply</p>
      <p className="font-serif text-sm text-content-primary leading-relaxed" style={{ lineHeight: '1.7' }}>{reply.content}</p>
      <div className="mt-3 flex items-center gap-3">
        <time className="text-ui-xs text-content-muted" dateTime={reply.publishedAt}>{formatDate(reply.publishedAt)}</time>
        {reply.articleSlug && (
          <Link
            href={`/article/${reply.articleSlug}`}
            className="text-ui-xs text-content-muted hover:text-content-primary transition-colors underline underline-offset-2"
            onClick={e => e.stopPropagation()}
          >
            {reply.articleTitle ?? 'View article'}
          </Link>
        )}
      </div>
    </div>
  )
}

function formatDate(iso: string) {
  const d = new Date(iso), now = new Date(), days = Math.floor((now.getTime()-d.getTime())/86400000)
  if (days===0) return 'Today'; if (days===1) return 'Yesterday'; if (days<7) return `${days}d ago`
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:d.getFullYear()!==now.getFullYear()?'numeric':undefined})
}
