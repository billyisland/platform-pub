'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { writers, type WriterProfile } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { ArticleCard } from '../../components/feed/ArticleCard'
import type { ArticleEvent } from '../../lib/ndk'

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
  const { user } = useAuth()
  const [writer, setWriter] = useState<WriterProfile | null>(null)
  const [articles, setArticles] = useState<DbArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [following, setFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [subStatus, setSubStatus] = useState<SubStatus | null>(null)
  const [subLoading, setSubLoading] = useState(false)

  // Load profile and articles
  useEffect(() => {
    async function loadProfile() {
      setLoading(true)
      try {
        const writerData = await writers.getProfile(username)
        setWriter(writerData)
        const articlesRes = await fetch(`/api/v1/writers/${username}/articles?limit=50`, { credentials: 'include' })
        if (articlesRes.ok) {
          const data = await articlesRes.json()
          setArticles(data.articles ?? [])
        }
      } catch (err: any) {
        if (err.status === 404) setNotFound(true)
        else console.error(err)
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
      } catch {}
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
  const hasPaywalledArticles = articles.some(a => a.isPaywalled)

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
        <h1 className="font-serif text-2xl font-light text-ink-900 mb-2">Writer not found</h1>
        <p className="text-ui-sm text-content-muted">No writer with the username @{username} exists on Platform.</p>
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

          {/* Action buttons */}
          {user && !isOwnProfile && writer && (
            <div className="flex items-center gap-2">
              {/* Follow button */}
              <button
                onClick={handleToggleFollow}
                disabled={followLoading}
                className={`transition-colors disabled:opacity-50 ${following ? 'btn-soft py-1.5 px-4 text-ui-xs' : 'btn py-1.5 px-4 text-ui-xs'}`}
              >
                {followLoading ? '...' : following ? 'Following' : 'Follow'}
              </button>

              {/* Subscribe button — only shown if writer has paywalled content */}
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
                    {subLoading ? '...' : `Subscribe £${((subStatus.pricePence ?? (writer as any).subscriptionPricePence ?? 500) / 100).toFixed(2)}/mo`}
                  </button>
                )
              )}
            </div>
          )}
        </div>

        {writer?.bio && (
          <p className="font-serif text-sm text-content-secondary leading-relaxed max-w-lg" style={{ lineHeight: '1.7' }}>{writer.bio}</p>
        )}
        <p className="mt-4 text-ui-xs text-content-faint">
          {articles.length} article{articles.length !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="rule mb-10" />

      {articles.length === 0 ? (
        <p className="text-ui-sm text-content-muted py-10">No published articles yet.</p>
      ) : (
        <div className="space-y-3">
          {articles.map(a => <DbArticleCard key={a.id} article={a} writerName={writer?.displayName ?? username} />)}
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

function formatDate(iso: string) {
  const d = new Date(iso), now = new Date(), days = Math.floor((now.getTime()-d.getTime())/86400000)
  if (days===0) return 'Today'; if (days===1) return 'Yesterday'; if (days<7) return `${days}d ago`
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:d.getFullYear()!==now.getFullYear()?'numeric':undefined})
}
