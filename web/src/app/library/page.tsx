'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { bookmarks as bookmarksApi, type BookmarkedArticle } from '../../lib/api'
import { BookmarkButton } from '../../components/ui/BookmarkButton'
import { ReadingHistory } from '../../components/account/ReadingHistory'
import { formatDateRelative, truncateText, stripMarkdown } from '../../lib/format'

type LibraryTab = 'bookmarks' | 'history'

export default function LibraryPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialTab = searchParams.get('tab') === 'history' ? 'history' : 'bookmarks'
  const [tab, setTab] = useState<LibraryTab>(initialTab)

  useEffect(() => { if (!authLoading && !user) router.push('/auth?mode=login') }, [user, authLoading, router])

  function switchTab(t: LibraryTab) {
    setTab(t)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', t)
    window.history.replaceState({}, '', url.toString())
  }

  if (authLoading || !user) {
    return (
      <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
        <div className="h-8 w-40 animate-pulse bg-white mb-10" />
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse bg-white" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
      <h1 className="font-sans text-2xl font-medium tracking-tight text-black mb-8">
        Library
      </h1>

      <div className="flex gap-2 mb-10">
        {(['bookmarks', 'history'] as LibraryTab[]).map(t => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            className={`tab-pill ${tab === t ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            {t === 'bookmarks' ? 'Bookmarks' : 'History'}
          </button>
        ))}
      </div>

      {tab === 'bookmarks' && <BookmarksTab />}
      {tab === 'history' && <ReadingHistory />}
    </div>
  )
}

function BookmarksTab() {
  const [articles, setArticles] = useState<BookmarkedArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  const loadBookmarks = useCallback(async (newOffset: number) => {
    try {
      const res = await bookmarksApi.list(20, newOffset)
      if (newOffset === 0) {
        setArticles(res.articles)
      } else {
        setArticles(prev => [...prev, ...res.articles])
      }
      setHasMore(res.hasMore)
      setOffset(newOffset + res.articles.length)
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadBookmarks(0) }, [loadBookmarks])

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse bg-white" />)}
      </div>
    )
  }

  if (articles.length === 0) {
    return (
      <div className="py-20 text-center">
        <p className="text-ui-sm text-grey-400 mb-4">No bookmarks yet.</p>
        <Link href="/feed" className="text-ui-xs text-black underline underline-offset-4">
          Browse the feed
        </Link>
      </div>
    )
  }

  return (
    <div className="divide-y-2 divide-grey-200">
      {articles.map(a => (
        <BookmarkCard
          key={a.nostr_event_id}
          article={a}
          onRemoved={(id) => setArticles(prev => prev.filter(x => x.nostr_event_id !== id))}
        />
      ))}
      {hasMore && (
        <div className="py-6 text-center">
          <button
            onClick={() => loadBookmarks(offset)}
            className="text-ui-xs text-black underline underline-offset-4"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  )
}

function BookmarkCard({
  article: a,
  onRemoved,
}: {
  article: BookmarkedArticle
  onRemoved: (nostrEventId: string) => void
}) {
  const publishedAt = a.published_at ? Math.floor(new Date(a.published_at).getTime() / 1000) : 0
  const excerpt = a.summary ? truncateText(stripMarkdown(a.summary), 120) : ''

  return (
    <Link href={`/article/${a.nostr_d_tag}`} className="block bg-white px-6 py-4 hover:bg-grey-50 transition-colors">
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-300 mb-1">
        {a.author_display_name ?? a.author_username}
        {publishedAt > 0 && (
          <> · {formatDateRelative(publishedAt)}</>
        )}
      </p>
      <h2 className="font-serif text-lg text-black leading-snug">
        {a.title}
      </h2>
      {excerpt && (
        <p className="text-[14px] font-sans text-grey-600 mt-1 leading-relaxed">
          {excerpt}
        </p>
      )}
    </Link>
  )
}
