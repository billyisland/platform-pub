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
      <div className="mt-3 border border-surface-strong bg-surface-sunken p-3 animate-pulse">
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
        className="block mt-3 border border-surface-strong bg-surface-sunken hover:bg-surface-raised transition-colors overflow-hidden"
      >
        <div className="flex items-stretch">
          <div className="w-[3px] bg-accent flex-shrink-0" />
          <div className="p-3">
            <p className="label-ui text-content-muted mb-1">{data.author.displayName}</p>
            <p className="text-ui-sm font-medium text-content-primary leading-snug mb-1">{data.title}</p>
            {data.content && (
              <p className="text-ui-xs text-content-secondary leading-relaxed line-clamp-2">{data.content}</p>
            )}
          </div>
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
      className="block mt-3 border border-surface-strong bg-surface-sunken hover:bg-surface-raised transition-colors p-3"
    >
      <div className="flex items-center gap-2 mb-1.5">
        {data.author.avatar ? (
          <img src={data.author.avatar} alt="" className="h-4 w-4 rounded-full object-cover flex-shrink-0" />
        ) : (
          <span className="flex h-4 w-4 items-center justify-center bg-surface-strong text-[8px] font-medium text-content-muted flex-shrink-0 rounded-full">
            {(data.author.displayName?.[0] ?? '?').toUpperCase()}
          </span>
        )}
        <span className="text-ui-xs font-medium text-content-primary">{data.author.displayName}</span>
      </div>
      <p className="text-ui-xs text-content-secondary leading-relaxed line-clamp-3">{data.content}</p>
    </Link>
  )
}
