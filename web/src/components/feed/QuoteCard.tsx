'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
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
  const ref = useRef<HTMLDivElement>(null)

  function applySwallowtail() {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    if (w === 0 || h === 0) return
    const forkDepth = 28
    const vX = ((w - forkDepth) / w) * 100
    el.style.clipPath = `polygon(0% 0%, 100% 0%, ${vX}% 50%, 100% 100%, 0% 100%)`
  }

  useEffect(() => {
    function run() { applySwallowtail() }
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.ready.then(run)
    } else {
      run()
    }
    window.addEventListener('resize', run)
    return () => window.removeEventListener('resize', run)
  }, [])

  return (
    <Link
      href={`/article/${data.dTag}`}
      onClick={e => e.stopPropagation()}
      className="block mt-2.5"
      style={{ marginRight: '-24px' }}
    >
      <div
        ref={ref}
        style={{
          background: '#F5F0E8',
          borderRadius: 0,
          borderLeft: data.isPaywalled ? '5px solid #9B1C20' : 'none',
          paddingTop: '10px',
          paddingBottom: '10px',
          paddingLeft: data.isPaywalled ? '11px' : '14px',
          paddingRight: '48px',
        }}
      >
        <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7A7774', marginBottom: '3px' }}>
          {data.author.displayName}
        </p>
        <p style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: '16px', fontWeight: 600, color: '#111111', lineHeight: 1.2 }}>
          {data.title}
        </p>
        {data.content && (
          <p style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: '13px', color: '#4A4845', lineHeight: 1.4, marginTop: '3px', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
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
      <div className="mt-2.5 p-3 animate-pulse" style={{ background: '#141414', borderRadius: '10px' }}>
        <div className="h-3 rounded w-1/3 mb-2" style={{ background: 'rgba(255,255,255,0.08)' }} />
        <div className="h-3 rounded w-2/3" style={{ background: 'rgba(255,255,255,0.08)' }} />
      </div>
    )
  }

  if (!data) return null

  if (data.type === 'article') {
    return <ArticlePennant data={data} />
  }

  // Quoted note — darker stone inset within the parent note
  const noteHref = data.author.username.length < 40 ? `/${data.author.username}` : null
  return (
    <Link
      href={noteHref ?? '#'}
      onClick={e => { e.stopPropagation(); if (!noteHref) e.preventDefault() }}
      className="block mt-2.5 p-3 hover:opacity-90 transition-opacity"
      style={{ background: '#141414', borderRadius: '10px' }}
    >
      <div className="flex items-center gap-2 mb-1">
        {data.author.avatar ? (
          <img src={data.author.avatar} alt="" className="h-4 w-4 rounded-full object-cover flex-shrink-0" />
        ) : (
          <span
            className="flex h-4 w-4 items-center justify-center text-[8px] font-medium flex-shrink-0 rounded-full"
            style={{ background: 'linear-gradient(135deg, #3A1515, #5A2020)', color: '#EAE5DC' }}
          >
            {(data.author.displayName?.[0] ?? '?').toUpperCase()}
          </span>
        )}
        <span style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '12px', fontWeight: 700, color: '#9E9B97' }}>
          {data.author.displayName}
        </span>
      </div>
      <p className="line-clamp-3" style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '13px', color: '#EAE5DC', lineHeight: 1.55 }}>
        {data.content}
      </p>
    </Link>
  )
}
