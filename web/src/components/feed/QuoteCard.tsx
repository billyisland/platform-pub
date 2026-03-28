'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { getNdk } from '../../lib/ndk'

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

  return (
    <Link
      href={`/article/${data.dTag}`}
      onClick={e => e.stopPropagation()}
      className="block mt-2.5"
    >
      <div
        style={{
          background: '#FFFAEF',
          borderLeft: '2.5px solid #B5242A',
          padding: '12px 16px',
        }}
      >
        <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8A8578', marginBottom: '3px' }}>
          {authorIsProfile ? (
            <span
              className="hover:underline underline-offset-2 cursor-pointer"
              onClick={e => { e.preventDefault(); e.stopPropagation(); router.push(`/${data.author.username}`) }}
            >
              {data.author.displayName}
            </span>
          ) : data.author.displayName}
        </p>
        <p style={{ fontFamily: '"Literata", Georgia, serif', fontSize: '16px', fontWeight: 500, fontStyle: 'italic', color: '#0F1F18', lineHeight: 1.25, letterSpacing: '-0.015em' }}>
          {data.title}
        </p>
        {data.content && (
          <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '13px', color: '#263D32', lineHeight: 1.5, marginTop: '4px', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
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
          setLoading(false)
          return
        }
      } catch { /* fall through */ }

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
      <div className="mt-2.5 p-3 animate-pulse" style={{ background: '#DDEEE4' }}>
        <div className="h-3 w-1/3 mb-2" style={{ background: '#B8D2C1' }} />
        <div className="h-3 w-2/3" style={{ background: '#B8D2C1' }} />
      </div>
    )
  }

  if (!data) return null

  if (data.type === 'article') {
    return <ArticlePennant data={data} />
  }

  // Quoted note — parchment chip with accent border
  const noteHref = data.author.username.length < 40 ? `/${data.author.username}` : null
  return (
    <Link
      href={noteHref ?? '#'}
      onClick={e => { e.stopPropagation(); if (!noteHref) e.preventDefault() }}
      className="block mt-2.5 hover:opacity-90 transition-opacity"
      style={{ background: '#FFFAEF', borderLeft: '2.5px solid #B5242A', padding: '12px 16px' }}
    >
      <div className="flex items-center gap-2 mb-1">
        {data.author.avatar ? (
          <img src={data.author.avatar} alt="" className="h-4 w-4 rounded-full object-cover flex-shrink-0" />
        ) : (
          <span
            className="flex h-4 w-4 items-center justify-center text-[8px] font-medium flex-shrink-0 rounded-full"
            style={{ background: '#C2DBC9', color: '#4A6B5A' }}
          >
            {(data.author.displayName?.[0] ?? '?').toUpperCase()}
          </span>
        )}
        <span style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 600, color: '#ACA69C' }}>
          {data.author.displayName}
        </span>
      </div>
      <p className="line-clamp-3" style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '13px', color: '#263D32', lineHeight: 1.55 }}>
        {data.content}
      </p>
    </Link>
  )
}
