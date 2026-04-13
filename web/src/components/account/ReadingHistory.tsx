'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { readingHistory, type ReadingHistoryItem } from '../../lib/api'
import { Avatar } from '../ui/Avatar'

const PAGE_SIZE = 20

export function ReadingHistory() {
  const [items, setItems] = useState<ReadingHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  async function fetchItems(offset: number, append: boolean) {
    if (offset === 0) setLoading(true)
    else setLoadingMore(true)
    try {
      const data = await readingHistory.list(PAGE_SIZE + 1, offset)
      const fetched = data.items
      const more = fetched.length > PAGE_SIZE
      if (more) fetched.pop()
      setItems(prev => append ? [...prev, ...fetched] : fetched)
      setHasMore(more)
    } catch {}
    finally { setLoading(false); setLoadingMore(false) }
  }

  useEffect(() => { fetchItems(0, false) }, [])

  if (loading) return <div className="h-12 animate-pulse bg-white" />
  if (items.length === 0) return null

  function articleHref(item: ReadingHistoryItem) {
    if (item.writer.username && item.slug) return `/@${item.writer.username}/${item.slug}`
    return null
  }

  return (
    <div className="mb-10">
      <p className="label-ui text-grey-400 mb-4">Reading history</p>
      <div className="bg-white divide-y divide-grey-200/50">
        {items.map(item => {
          const href = articleHref(item)
          return (
            <div key={`${item.articleId}-${item.readAt}`} className="flex items-center gap-3 px-6 py-4">
              {item.writer.username ? (
                <Link href={`/@${item.writer.username}`} className="flex-shrink-0">
                  <Avatar src={item.writer.avatar} name={item.writer.displayName || item.writer.username} size={28} />
                </Link>
              ) : (
                <Avatar src={item.writer.avatar} name={item.writer.displayName || '?'} size={28} />
              )}
              <div className="min-w-0 flex-1">
                {href ? (
                  <Link href={href} className="text-[14px] font-sans text-black hover:opacity-70 line-clamp-1">
                    {item.title || 'Untitled'}
                  </Link>
                ) : (
                  <p className="text-[14px] font-sans text-black line-clamp-1">{item.title || 'Untitled'}</p>
                )}
                <p className="font-mono text-[12px] text-grey-300 uppercase tracking-[0.06em]">
                  {item.writer.displayName || item.writer.username ? `by @${item.writer.username}` : 'Unknown writer'}
                  {' \u00b7 '}
                  {new Date(item.readAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </p>
              </div>
              <span className={`flex-shrink-0 font-mono text-[12px] tabular-nums ${item.isPaywalled ? 'text-black' : 'text-grey-300'}`}>
                {item.isPaywalled ? 'Paid' : 'Free'}
              </span>
            </div>
          )
        })}
      </div>
      {hasMore && (
        <div className="mt-4 text-center">
          <button
            onClick={() => fetchItems(items.length, true)}
            disabled={loadingMore}
            className="text-ui-xs text-black underline underline-offset-4 hover:opacity-70 disabled:opacity-50"
          >
            {loadingMore ? 'Loading\u2026' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  )
}
