'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface ResolvedContent {
  type: 'note' | 'article'
  eventId: string
  content: string
  title?: string
  dTag?: string
  publishedAt: number
  author: {
    username: string
    displayName: string
    avatar?: string
  }
}

interface QuoteCardProps {
  eventId: string
}

export function QuoteCard({ eventId }: QuoteCardProps) {
  const [data, setData] = useState<ResolvedContent | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/v1/content/resolve?eventId=${encodeURIComponent(eventId)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [eventId])

  if (loading) {
    return (
      <div className="border border-surface-strong bg-surface-sunken p-3 mt-2 animate-pulse">
        <div className="h-3 bg-surface-strong rounded w-1/3 mb-2" />
        <div className="h-3 bg-surface-strong rounded w-2/3" />
      </div>
    )
  }

  if (!data) return null

  if (data.type === 'article') {
    return (
      <Link
        href={`/article/${data.dTag}`}
        onClick={e => e.stopPropagation()}
        className="block border border-surface-strong bg-surface-sunken p-3 mt-2 border-l-[3px] border-l-accent hover:bg-surface-raised transition-colors"
      >
        <p className="label-ui text-content-muted mb-1">{data.author.displayName}</p>
        <p className="text-ui-sm font-medium text-content-primary leading-snug mb-1">{data.title}</p>
        {data.content && (
          <p className="text-ui-xs text-content-secondary leading-relaxed line-clamp-2">{data.content}</p>
        )}
      </Link>
    )
  }

  // Note
  return (
    <div className="border border-surface-strong bg-surface-sunken p-3 mt-2">
      <div className="flex items-center gap-2 mb-1">
        {data.author.avatar ? (
          <img src={data.author.avatar} alt="" className="h-5 w-5 rounded-full object-cover flex-shrink-0" />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center bg-surface-strong text-[9px] font-medium text-content-muted flex-shrink-0 rounded-full">
            {(data.author.displayName?.[0] ?? '?').toUpperCase()}
          </span>
        )}
        <span className="text-ui-xs font-medium text-content-muted">{data.author.displayName}</span>
      </div>
      <p className="text-ui-xs text-content-secondary leading-relaxed line-clamp-3">{data.content}</p>
    </div>
  )
}
