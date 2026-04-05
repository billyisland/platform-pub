'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { readingHistory, type ReadingHistoryItem } from '../../lib/api'

// =============================================================================
// Reading History Page (/history)
//
// Shows the current reader's previously-read articles, most recent first.
// Data comes from read_events which is populated on every gate-pass.
// =============================================================================

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function HistoryItemRow({ item }: { item: ReadingHistoryItem }) {
  const href = item.dTag ? `/article/${item.dTag}` : '#'
  const writerName = item.writer.displayName ?? item.writer.username ?? 'Unknown'
  const readMinutes = item.wordCount ? Math.max(1, Math.round(item.wordCount / 200)) : null

  return (
    <Link
      href={href}
      className="flex items-start gap-3 py-4 mb-1 hover:bg-white transition-colors"
    >
      <div className="min-w-0 flex-1">
        <p className="font-serif text-base text-black leading-snug mb-1">
          {item.title ?? 'Untitled'}
        </p>
        <div className="flex items-center gap-2 text-ui-xs text-grey-400 flex-wrap">
          <span>{writerName}</span>
          {readMinutes && (
            <>
              <span className="opacity-40">/</span>
              <span>{readMinutes} min</span>
            </>
          )}
          {item.isPaywalled && (
            <>
              <span className="opacity-40">/</span>
              <span className="text-crimson">£</span>
            </>
          )}
          <span className="opacity-40">/</span>
          <span>Read {timeAgo(item.readAt)}</span>
        </div>
      </div>
    </Link>
  )
}

export default function HistoryPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [items, setItems] = useState<ReadingHistoryItem[]>([])
  const [dataLoading, setDataLoading] = useState(true)

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  useEffect(() => {
    if (!user) return
    readingHistory.list()
      .then(({ items }) => setItems(items))
      .catch(err => console.error('Failed to load reading history', err))
      .finally(() => setDataLoading(false))
  }, [user])

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article pt-16 lg:pt-0 px-4 sm:px-6 py-8">
        <div className="h-7 w-36 animate-pulse bg-grey-100 mb-2 rounded" />
        <div className="h-4 w-48 animate-pulse bg-grey-100 mb-8 rounded" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0 px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl sm:text-4xl font-light text-black mb-1">Reading History</h1>
      <p className="text-ui-sm text-grey-400 mb-8">Articles you've read</p>

      {dataLoading ? (
        <div className="space-y-1">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="py-4 mb-1 animate-pulse">
              <div className="h-4 w-3/4 bg-grey-100 mb-2 rounded" />
              <div className="h-3 w-40 bg-grey-100 rounded" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-400">You haven't read any articles yet</p>
        </div>
      ) : (
        <div>
          {items.map((item) => (
            <HistoryItemRow key={item.articleId} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
