'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { isImageUrl, extractUrls } from '../../lib/media'

interface ResolvedContent {
  type: 'note' | 'article'
  eventId: string
  content: string
  title?: string
  dTag?: string
  isPaywalled?: boolean
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

function ArticlePennant({ data }: { data: ResolvedContent }) {
  const router = useRouter()
  const authorIsProfile = data.author.username.length < 40
  const barColor = data.isPaywalled ? '#B5242A' : '#111111'

  return (
    <Link
      href={`/article/${data.dTag}`}
      onClick={e => e.stopPropagation()}
      className="block mt-2.5 ml-[38px]"
    >
      <div
        className="py-3 px-5"
        style={{ borderLeft: `4px solid ${barColor}` }}
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-grey-600 mb-1">
          {authorIsProfile ? (
            <span
              className="hover:underline underline-offset-2 cursor-pointer"
              onClick={e => { e.preventDefault(); e.stopPropagation(); router.push(`/${data.author.username}`) }}
            >
              {data.author.displayName}
            </span>
          ) : data.author.displayName}
        </p>
        <p className="font-serif text-[16px] font-medium italic text-black leading-[1.25] tracking-[-0.015em]">
          {data.title}
        </p>
        {data.content && (
          <p className="font-serif text-[13px] text-grey-600 leading-[1.5] mt-1 line-clamp-2">
            {data.content}
          </p>
        )}
      </div>
    </Link>
  )
}

export function QuoteCard({ eventId }: QuoteCardProps) {
  const [data, setData] = useState<ResolvedContent | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function fetchData() {
      try {
        const r = await fetch(`/api/v1/content/resolve?eventId=${encodeURIComponent(eventId)}`, { credentials: 'include' })
        if (!cancelled && r.ok) {
          setData(await r.json())
        }
      } catch { /* ignore */ }

      if (!cancelled) setLoading(false)
    }

    void fetchData()
    return () => { cancelled = true }
  }, [eventId])

  if (loading) {
    return (
      <div className="mt-2.5 ml-[38px] p-3 animate-pulse bg-grey-100">
        <div className="h-3 w-1/3 mb-2 bg-grey-200" />
        <div className="h-3 w-2/3 bg-grey-200" />
      </div>
    )
  }

  if (!data) return null

  if (data.type === 'article') {
    return <ArticlePennant data={data} />
  }

  // Quoted note — 4px grey-300 left border
  const noteHref = data.author.username.length < 40 ? `/${data.author.username}` : null
  const urls = extractUrls(data.content)
  const imageUrls = urls.filter(isImageUrl)
  let displayContent = data.content
  for (const url of imageUrls) displayContent = displayContent.replace(url, '').trim()

  return (
    <Link
      href={noteHref ?? '#'}
      onClick={e => { e.stopPropagation(); if (!noteHref) e.preventDefault() }}
      className="block mt-2.5 ml-[38px] hover:opacity-90 transition-opacity"
      style={{ borderLeft: '4px solid #BBBBBB', padding: '8px 20px' }}
    >
      <div className="flex items-center gap-2 mb-1">
        {data.author.avatar ? (
          <img src={data.author.avatar} alt="" className="h-[18px] w-[18px] object-cover flex-shrink-0" />
        ) : (
          <span className="flex h-[18px] w-[18px] items-center justify-center text-[8px] font-mono uppercase flex-shrink-0 bg-grey-200 text-grey-400">
            {(data.author.displayName?.[0] ?? '?').toUpperCase()}
          </span>
        )}
        <span className="font-sans text-[12px] font-semibold text-grey-600">
          {data.author.displayName}
        </span>
      </div>
      {displayContent && (
        <p className="line-clamp-3 font-sans text-ui-sm text-grey-600 leading-[1.55]">
          {displayContent}
        </p>
      )}
      {imageUrls.length > 0 && (
        <div className="mt-1.5 space-y-1.5">
          {imageUrls.map((url, i) => (
            <img key={i} src={url} alt="" className="max-w-full max-h-48 object-cover rounded-sm" loading="lazy" />
          ))}
        </div>
      )}
    </Link>
  )
}
