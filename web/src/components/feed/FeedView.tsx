'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { ArticleCard } from '../feed/ArticleCard'
import { NoteCard } from '../feed/NoteCard'
import { NoteComposer } from '../feed/NoteComposer'
import type { FeedItem, NoteEvent } from '../../lib/ndk'
import { getNdk, parseArticleEvent, parseNoteEvent, KIND_ARTICLE, KIND_NOTE, KIND_DELETION } from '../../lib/ndk'
import type { NDKKind } from '@nostr-dev-kit/ndk'

type FeedTab = 'for-you' | 'following' | 'add'

export function FeedView() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<FeedTab>('for-you')
  const [feedItems, setFeedItems] = useState<FeedItem[]>([])
  const [feedLoading, setFeedLoading] = useState(true)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  useEffect(() => {
    if (!user || activeTab === 'add') return
    async function loadFeed() {
      setFeedLoading(true)
      try {
        const ndk = getNdk(); await ndk.connect()
        if (activeTab === 'following') {
          const pks = await fetchFollowedPubkeys(user!.id)
          const af = pks.length > 0 ? { authors: pks } : {}
          const [articleEvents, noteEvents, deletionEvents] = await Promise.all([
            ndk.fetchEvents({ kinds: [KIND_ARTICLE as NDKKind], limit: 30, ...af }),
            ndk.fetchEvents({ kinds: [KIND_NOTE as NDKKind], limit: 30, ...af }),
            ndk.fetchEvents({ kinds: [KIND_DELETION as NDKKind], limit: 100, ...af }),
          ])
          const deletedIds = new Set<string>()
          const deletedCoords = new Set<string>()
          for (const d of deletionEvents) for (const t of d.tags) {
            if (t[0] === 'e') deletedIds.add(t[1])
            if (t[0] === 'a') deletedCoords.add(t[1])
          }
          const isArticleDeleted = (e: { id: string; pubkey: string; tags: string[][] }) => {
            if (deletedIds.has(e.id)) return true
            const dTag = e.tags.find(t => t[0] === 'd')?.[1]
            return dTag != null && deletedCoords.has(`30023:${e.pubkey}:${dTag}`)
          }
          const articles: FeedItem[] = Array.from(articleEvents).filter(e => !isArticleDeleted(e)).map(e => ({ ...parseArticleEvent(e), type: 'article' as const }))
          const notes: FeedItem[] = Array.from(noteEvents).filter(e => !e.tags.find(t => t[0] === 'e')).filter(e => !deletedIds.has(e.id)).map(e => parseNoteEvent(e))
          setFeedItems([...articles, ...notes].sort((a, b) => b.publishedAt - a.publishedAt))
        } else {
          setFeedItems([])
        }
      } catch (err) { console.error('Feed load error:', err) }
      finally { setFeedLoading(false) }
    }
    loadFeed()
  }, [user, activeTab])

  const handleNotePublished = useCallback((note: NoteEvent) => { setFeedItems(prev => [note, ...prev]) }, [])
  const handleNoteDeleted = useCallback((id: string) => { setFeedItems(prev => prev.filter(i => i.id !== id)) }, [])

  if (loading || !user) return <FeedSkeleton />

  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0">

      {/* ── Sticky zone: composer + tabs ── */}
      <div className="sticky top-[53px] lg:top-0 z-10 bg-surface">
        <div className="px-6 pt-4">
          <NoteComposer onPublished={handleNotePublished} />
        </div>
        <div className="flex px-6 pt-1 border-b border-surface-strong">
          <button
            onClick={() => setActiveTab('for-you')}
            className={`tab-pill ${activeTab === 'for-you' ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            For you
          </button>
          <button
            onClick={() => setActiveTab('following')}
            className={`tab-pill ${activeTab === 'following' ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            Following
          </button>
          <button
            onClick={() => setActiveTab('add')}
            className={`tab-pill ${activeTab === 'add' ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            Add
          </button>
        </div>
      </div>

      {/* ── Content zone ── */}
      <div className="pb-10">
        {activeTab === 'add' ? (
          <AddPanel onFollowed={() => setActiveTab('following')} />
        ) : feedLoading ? (
          <InlineSkeleton />
        ) : feedItems.length === 0 ? (
          <div className="py-20 text-center px-6">
            <p className="text-ui-sm text-content-muted">
              {activeTab === 'following'
                ? 'Nothing here yet. Use the Add tab to follow writers.'
                : 'For You recommendations are coming soon.'}
            </p>
          </div>
        ) : (
          <div>
            {feedItems.map(item => item.type === 'article'
              ? <ArticleCard key={item.id} article={item} />
              : <NoteCard key={item.id} note={item} onDeleted={handleNoteDeleted} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// Add panel — search people and feeds
// =============================================================================

interface WriterResult {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  bio: string | null
  articleCount: number
}

function AddPanel({ onFollowed }: { onFollowed: () => void }) {
  const [mode, setMode] = useState<'people' | 'feeds'>('people')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WriterResult[]>([])
  const [searching, setSearching] = useState(false)
  const [followed, setFollowed] = useState<Set<string>>(new Set())
  const [rssUrl, setRssUrl] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (mode !== 'people' || query.trim().length < 2) {
      setResults([])
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/v1/search?type=writers&q=${encodeURIComponent(query.trim())}&limit=10`, { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          setResults(data.writers ?? [])
        }
      } catch { /* ignore */ }
      finally { setSearching(false) }
    }, 300)
  }, [query, mode])

  async function handleFollow(writerId: string) {
    try {
      const res = await fetch(`/api/v1/follows/${writerId}`, { method: 'POST', credentials: 'include' })
      if (res.ok) {
        setFollowed(prev => new Set([...prev, writerId]))
        onFollowed()
      }
    } catch { /* ignore */ }
  }

  return (
    <div className="px-6 pt-5">
      {/* Mode toggle */}
      <div className="flex gap-0 mb-4 border-b border-surface-strong">
        <button
          onClick={() => setMode('people')}
          className={`tab-pill ${mode === 'people' ? 'tab-pill-active' : 'tab-pill-inactive'}`}
        >
          People
        </button>
        <button
          onClick={() => setMode('feeds')}
          className={`tab-pill ${mode === 'feeds' ? 'tab-pill-active' : 'tab-pill-inactive'}`}
        >
          Feeds
        </button>
      </div>

      {mode === 'people' ? (
        <>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search for writers..."
            autoFocus
            className="w-full bg-surface-sunken px-4 py-3 text-ui-sm text-content-primary placeholder:text-content-faint focus:bg-white focus:outline-none transition-colors mb-4"
          />

          {searching && (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <div key={i} className="h-14 animate-pulse bg-surface-raised" />)}
            </div>
          )}

          {!searching && results.length === 0 && query.trim().length >= 2 && (
            <p className="text-ui-sm text-content-muted text-center py-8">No writers found.</p>
          )}

          {!searching && results.map(w => (
            <div key={w.id} className="flex items-center gap-3 py-3 border-b border-surface-strong last:border-b-0">
              {w.avatar ? (
                <img src={w.avatar} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
              ) : (
                <span className="flex h-9 w-9 items-center justify-center bg-surface-sunken text-xs font-medium text-content-muted flex-shrink-0 rounded-full">
                  {(w.displayName ?? w.username)[0].toUpperCase()}
                </span>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-ui-sm font-medium text-content-primary truncate">{w.displayName ?? w.username}</p>
                <p className="text-ui-xs text-content-muted">@{w.username} &middot; {w.articleCount} articles</p>
              </div>
              <button
                onClick={() => handleFollow(w.id)}
                disabled={followed.has(w.id)}
                className="btn disabled:opacity-50 py-1.5 px-4 text-ui-xs flex-shrink-0"
              >
                {followed.has(w.id) ? 'Following' : 'Follow'}
              </button>
            </div>
          ))}
        </>
      ) : (
        <>
          <input
            type="url"
            value={rssUrl}
            onChange={e => setRssUrl(e.target.value)}
            placeholder="Paste an RSS or Atom feed URL..."
            autoFocus
            className="w-full bg-surface-sunken px-4 py-3 text-ui-sm text-content-primary placeholder:text-content-faint focus:bg-white focus:outline-none transition-colors mb-4"
          />
          <p className="text-ui-xs text-content-faint mb-4">
            External feed following is coming soon. Paste a feed URL to get notified when it's ready.
          </p>
          <button
            disabled={rssUrl.trim().length < 8}
            className="btn disabled:opacity-40 py-2 px-5 text-ui-xs"
          >
            Follow feed
          </button>
        </>
      )}
    </div>
  )
}

// =============================================================================
// Skeletons
// =============================================================================

function FeedSkeleton() {
  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0 px-6 py-10 space-y-3">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-surface-raised p-5">
          <div className="h-3 w-24 animate-pulse bg-surface-sunken mb-4" />
          <div className="h-5 w-3/4 animate-pulse bg-surface-sunken mb-3" />
          <div className="h-3 w-full animate-pulse bg-surface-sunken" />
        </div>
      ))}
    </div>
  )
}

function InlineSkeleton() {
  return (
    <div className="px-6 pt-4 space-y-3">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-surface-raised p-5">
          <div className="h-3 w-24 animate-pulse bg-surface-sunken mb-4" />
          <div className="h-5 w-3/4 animate-pulse bg-surface-sunken mb-3" />
          <div className="h-3 w-full animate-pulse bg-surface-sunken" />
        </div>
      ))}
    </div>
  )
}

async function fetchFollowedPubkeys(readerId: string): Promise<string[]> {
  try {
    const res = await fetch('/api/v1/follows/pubkeys', { credentials: 'include' })
    if (!res.ok) return []
    return (await res.json()).pubkeys ?? []
  } catch { return [] }
}
