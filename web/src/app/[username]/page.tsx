'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { writers, type WriterProfile } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import Link from 'next/link'

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

      {activity.length === 0 ? (
        <p className="text-ui-sm text-content-muted py-10">Looks like {writer?.displayName ?? username} hasn't said anything yet.</p>
      ) : (
        <div className="space-y-3">
          {activity.map(item => {
            if (item.kind === 'article') {
              return <DbArticleCard key={item.data.id} article={item.data as DbArticle} writerName={writer?.displayName ?? username} />
            }
            if (item.kind === 'note') {
              return <DbNoteCard key={item.data.id} note={item.data as DbNote} writerName={writer?.displayName ?? username} />
            }
            return <DbReplyCard key={item.data.id} reply={item.data as DbReply} writerName={writer?.displayName ?? username} />
          })}
        </div>
      )}
    </div>
  )
}

function DbArticleCard({ article, writerName }: { article: DbArticle; writerName: string }) {
  const wordCount = article.wordCount ?? 0
  const readMinutes = Math.max(1, Math.round(wordCount / 200))

  return (
    <a href={`/article/${article.dTag}`} className="group block bg-surface-raised p-5 border-l-[3px] border-accent">
      <p className="label-ui text-content-muted mb-3">{writerName}</p>
      <h2 className="font-serif text-xl font-normal text-content-primary group-hover:opacity-80 transition-opacity mb-2 leading-snug tracking-tight">{article.title}</h2>
      {article.summary && <p className="font-serif text-sm text-content-secondary leading-relaxed mb-4" style={{ lineHeight: '1.7' }}>{article.summary}</p>}
      <div className="flex items-center gap-3 text-ui-xs text-content-muted">
        {article.publishedAt && <time dateTime={article.publishedAt}>{formatDate(article.publishedAt)}</time>}
        {wordCount > 0 && <><span className="opacity-40">/</span><span>{readMinutes} min</span></>}
        {article.isPaywalled && <><span className="opacity-40">/</span><span className="text-accent">£</span></>}
      </div>
    </a>
  )
}

function DbNoteCard({ note, writerName }: { note: DbNote; writerName: string }) {
  return (
    <div className="bg-surface-raised p-5 border-l-[3px] border-surface-strong">
      <p className="label-ui text-content-muted mb-3">{writerName} · Note</p>
      <p className="font-serif text-sm text-content-primary leading-relaxed" style={{ lineHeight: '1.7' }}>{note.content}</p>
      <p className="mt-3 text-ui-xs text-content-muted"><time dateTime={note.publishedAt}>{formatDate(note.publishedAt)}</time></p>
    </div>
  )
}

function DbReplyCard({ reply, writerName }: { reply: DbReply; writerName: string }) {
  return (
    <div className="bg-surface-raised p-5 border-l-[3px] border-surface-strong opacity-80">
      <p className="label-ui text-content-muted mb-3">{writerName} · Reply</p>
      <p className="font-serif text-sm text-content-primary leading-relaxed" style={{ lineHeight: '1.7' }}>{reply.content}</p>
      <p className="mt-3 text-ui-xs text-content-muted"><time dateTime={reply.publishedAt}>{formatDate(reply.publishedAt)}</time></p>
    </div>
  )
}

function formatDate(iso: string) {
  const d = new Date(iso), now = new Date(), days = Math.floor((now.getTime()-d.getTime())/86400000)
  if (days===0) return 'Today'; if (days===1) return 'Yesterday'; if (days<7) return `${days}d ago`
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:d.getFullYear()!==now.getFullYear()?'numeric':undefined})
}
