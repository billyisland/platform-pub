'use client'

import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

interface ArticleResult { id: string; dTag: string; title: string; summary: string | null; wordCount: number | null; isPaywalled: boolean; publishedAt: string; writer: { username: string; displayName: string | null }; relevance: number }
interface WriterResult { id: string; username: string; displayName: string | null; bio: string | null; avatar: string | null; articleCount: number }
type SearchTab = 'users' | 'content'

export default function SearchPage() {
  const searchParams = useSearchParams()
  const initialQ = searchParams.get('q') ?? ''
  const [query, setQuery] = useState(initialQ)
  const [activeTab, setActiveTab] = useState<SearchTab>('users')
  const [articleResults, setArticleResults] = useState<ArticleResult[]>([])
  const [writerResults, setWriterResults] = useState<WriterResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  const handleSearch = useCallback(async (q?: string) => {
    const searchQuery = (q ?? query).trim()
    if (searchQuery.length < 2) return
    setLoading(true)
    setSearched(true)

    try {
      // Fetch BOTH types in parallel — tabs just filter the display
      const [articlesRes, writersRes] = await Promise.all([
        fetch(`/api/v1/search?q=${encodeURIComponent(searchQuery)}&type=articles&limit=20`, { credentials: 'include' }),
        fetch(`/api/v1/search?q=${encodeURIComponent(searchQuery)}&type=writers&limit=20`, { credentials: 'include' }),
      ])

      const [articlesData, writersData] = await Promise.all([
        articlesRes.json(),
        writersRes.json(),
      ])

      const writers = writersData.results ?? []
      const articles = articlesData.results ?? []
      setArticleResults(articles)
      setWriterResults(writers)
      // Default to Users; fall back to Content only when no user results
      setActiveTab(writers.length === 0 && articles.length > 0 ? 'content' : 'users')
    } catch {
      // Silently fail — results just stay empty
    } finally {
      setLoading(false)
    }
  }, [query])

  // Auto-search on mount if there's a query param
  useEffect(() => {
    if (initialQ.trim().length >= 2) {
      handleSearch(initialQ)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const articleCount = articleResults.length
  const writerCount = writerResults.length

  return (
    <div className="mx-auto max-w-article px-6 py-12">
      <h1 className="font-serif text-2xl font-light text-black mb-8 tracking-tight">Search</h1>

      {/* Search input */}
      <div className="flex gap-2 mb-8">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Search articles and writers..."
          className="flex-1 px-4 py-2.5 text-ui-sm"
        />
        <button
          onClick={() => handleSearch()}
          disabled={loading || query.trim().length < 2}
          className="btn disabled:opacity-50"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {/* Tabs — just toggle visibility, no re-fetch */}
      {searched && (
        <div className="flex gap-2 mb-8">
          <button
            onClick={() => setActiveTab('users')}
            className={`tab-pill ${activeTab === 'users' ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            Users{writerCount > 0 ? ` (${writerCount})` : ''}
          </button>
          <button
            onClick={() => setActiveTab('content')}
            className={`tab-pill ${activeTab === 'content' ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            Content{articleCount > 0 ? ` (${articleCount})` : ''}
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-4">
          {[1,2,3].map(i => <div key={i} className="h-14 animate-pulse bg-white" />)}
        </div>
      )}

      {/* Content results */}
      {!loading && searched && activeTab === 'content' && (
        articleResults.length === 0 ? (
          <p className="text-ui-sm text-grey-400 py-10 text-center">
            No articles found for &ldquo;{query}&rdquo;.
          </p>
        ) : (
          <div className="space-y-1">
            {articleResults.map(a => (
              <Link key={a.id} href={`/article/${a.dTag}`} className="block bg-white p-4 group">
                <p className="label-ui text-grey-400 mb-2">{a.writer.displayName ?? a.writer.username}</p>
                <h3 className="font-serif text-base font-normal text-black group-hover:opacity-70 transition-opacity mb-1 tracking-tight">{a.title}</h3>
                {a.summary && <p className="font-serif text-sm text-grey-400 line-clamp-2" style={{ lineHeight: '1.65' }}>{a.summary}</p>}
              </Link>
            ))}
          </div>
        )
      )}

      {/* User results */}
      {!loading && searched && activeTab === 'users' && (
        writerResults.length === 0 ? (
          <p className="text-ui-sm text-grey-400 py-10 text-center">
            No writers found for &ldquo;{query}&rdquo;.
          </p>
        ) : (
          <div className="space-y-1">
            {writerResults.map(w => (
              <Link key={w.id} href={`/${w.username}`} className="flex items-center gap-4 bg-white p-4 group">
                {w.avatar ? (
                  <img src={w.avatar} alt="" className="h-9 w-9 rounded-full object-cover" />
                ) : (
                  <span className="flex h-9 w-9 items-center justify-center bg-grey-100 text-xs font-medium text-grey-400">
                    {(w.displayName ?? w.username)[0].toUpperCase()}
                  </span>
                )}
                <div>
                  <p className="text-ui-sm text-black group-hover:opacity-70 transition-opacity">{w.displayName ?? w.username}</p>
                  <p className="text-ui-xs text-grey-300">@{w.username} / {w.articleCount} article{w.articleCount !== 1 ? 's' : ''}</p>
                </div>
              </Link>
            ))}
          </div>
        )
      )}
    </div>
  )
}
