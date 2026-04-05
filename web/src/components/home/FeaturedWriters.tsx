'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { formatDateRelative, truncateText, stripMarkdown } from '../../lib/format'
import { feed as feedApi } from '../../lib/api'

interface FeaturedArticle {
  dTag: string
  title: string
  summary: string | null
  contentFree: string
  publishedAt: number
  pricePence: number | null
  isPaywalled: boolean
  authorDisplayName: string | null
  authorUsername: string | null
}

export function FeaturedWriters() {
  const [articles, setArticles] = useState<FeaturedArticle[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    feedApi.featured()
      .then(data => setArticles((data.articles ?? []).slice(0, 3)))
      .catch(err => console.error('Failed to load featured writers', err))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div>
        {[1, 2, 3].map(i => (
          <div key={i} className="py-6 pl-[34px]" style={{ borderLeft: '6px solid #E5E5E5' }}>
            <div className="h-3 w-24 animate-pulse bg-grey-200 mb-4" />
            <div className="h-5 w-3/4 animate-pulse bg-grey-200 mb-3" />
            <div className="h-3 w-full animate-pulse bg-grey-200" />
          </div>
        ))}
      </div>
    )
  }

  if (articles.length === 0) return null

  return (
    <div>
      {articles.map(article => (
        <FeaturedCard key={article.dTag} article={article} />
      ))}
    </div>
  )
}

function FeaturedCard({ article }: { article: FeaturedArticle }) {
  const excerpt = article.summary || truncateText(stripMarkdown(article.contentFree), 200)
  const wordCount = article.contentFree.split(/\s+/).length
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const barColor = article.isPaywalled ? '#B5242A' : '#111111'

  return (
    <Link
      href={`/article/${article.dTag}`}
      className="block py-6 pl-[34px] mt-4 transition-opacity hover:opacity-80"
      style={{ borderLeft: `6px solid ${barColor}` }}
    >
      {article.authorDisplayName && (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600 mb-2.5">
          {article.authorDisplayName}
        </p>
      )}

      <h2 className="font-serif text-[28px] font-medium italic text-black leading-[1.18] tracking-[-0.02em] mb-2.5">
        {article.title}
      </h2>

      <p className="font-serif text-[15.5px] text-grey-600 leading-[1.6] mb-3.5" style={{ maxWidth: '540px' }}>
        {excerpt}
      </p>

      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-600">
        <span>{formatDateRelative(article.publishedAt)}</span>
        <span className="opacity-40">·</span>
        <span>{readMinutes} min</span>
        {article.isPaywalled && article.pricePence && (
          <>
            <span className="opacity-40">·</span>
            <span className="text-crimson">£{(article.pricePence / 100).toFixed(2)}</span>
          </>
        )}
      </div>
    </Link>
  )
}
