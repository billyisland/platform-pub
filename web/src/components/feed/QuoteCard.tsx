'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { getNdk } from '../../lib/ndk'

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
    let cancelled = false

    async function fetchData() {
      // Phase 1: try the platform index (richer author info)
      try {
        const r = await fetch(`/api/v1/content/resolve?eventId=${encodeURIComponent(eventId)}`, { credentials: 'include' })
        if (!cancelled && r.ok) {
          setData(await r.json())
          setLoading(false)
          return
        }
      } catch { /* fall through */ }

      // Phase 2: fall back to the Nostr relay so external / un-indexed notes render
      try {
        const ndk = getNdk()
        await ndk.connect()
        const event = await ndk.fetchEvent(eventId)
        if (!cancelled && event) {
          setData({
            type: 'note',
            eventId: event.id,
            content: (event.content ?? '').slice(0, 200),
            publishedAt: event.created_at ?? 0,
            author: {
              username: event.pubkey,
              displayName: event.pubkey.slice(0, 8) + '…',
            },
          })
        }
      } catch { /* give up */ }

      if (!cancelled) setLoading(false)
    }

    fetchData()
    return () => { cancelled = true }
  }, [eventId])

  if (loading) {
    return (
      <div className="mt-2.5 bg-surface-sunken/60 rounded-lg border-l-[2.5px] border-accent p-3 animate-pulse">
        <div className="h-3 bg-surface-strong/50 rounded w-1/3 mb-2" />
        <div className="h-3 bg-surface-strong/50 rounded w-2/3" />
      </div>
    )
  }

  if (!data) return null

  if (data.type === 'article') {
    return (
      <Link
        href={`/article/${data.dTag}`}
        onClick={e => e.stopPropagation()}
        className="block mt-2.5 bg-surface-sunken/60 hover:bg-surface-sunken rounded-lg border-l-[2.5px] border-accent transition-colors overflow-hidden"
      >
        <div className="p-3">
          <p className="text-ui-xs font-medium text-content-muted">{data.author.displayName}</p>
          <p className="text-ui-sm font-medium text-content-primary leading-snug mt-0.5 mb-0.5">{data.title}</p>
          {data.content && (
            <p className="text-ui-xs text-content-secondary leading-relaxed line-clamp-2">{data.content}</p>
          )}
        </div>
      </Link>
    )
  }

  // Note — links to author profile if the username looks like a real slug, not a raw pubkey
  const noteHref = data.author.username.length < 40 ? `/${data.author.username}` : null
  return (
    <Link
      href={noteHref ?? '#'}
      onClick={e => { e.stopPropagation(); if (!noteHref) e.preventDefault() }}
      className="block mt-2.5 bg-surface-sunken/60 hover:bg-surface-sunken rounded-lg border-l-[2.5px] border-accent transition-colors p-3"
    >
      <div className="flex items-center gap-2 mb-1">
        {data.author.avatar ? (
          <img src={data.author.avatar} alt="" className="h-4 w-4 rounded-full object-cover flex-shrink-0" />
        ) : (
          <span
            className="flex h-4 w-4 items-center justify-center text-[8px] font-medium text-accent-700 flex-shrink-0 rounded-full"
            style={{ background: 'linear-gradient(135deg, #F5D5D6, #E8A5A7)' }}
          >
            {(data.author.displayName?.[0] ?? '?').toUpperCase()}
          </span>
        )}
        <span className="text-ui-xs font-medium text-content-muted">{data.author.displayName}</span>
      </div>
      <p className="text-ui-xs text-content-secondary leading-relaxed line-clamp-3">{data.content}</p>
    </Link>
  )
}
