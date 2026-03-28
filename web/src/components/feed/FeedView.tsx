'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { ArticleCard } from '../feed/ArticleCard'
import { NoteCard } from '../feed/NoteCard'
import { NoteComposer } from '../feed/NoteComposer'
import type { FeedItem, NoteEvent } from '../../lib/ndk'
import { getNdk, parseArticleEvent, parseNoteEvent, KIND_ARTICLE, KIND_NOTE, KIND_DELETION } from '../../lib/ndk'
import type { QuoteTarget } from '../../lib/publishNote'
import type { NDKKind } from '@nostr-dev-kit/ndk'
import type { VoteTally, MyVoteCount } from '../../lib/api'

type FeedTab = 'for-you' | 'following' | 'add'

interface NewUserItem {
  type: 'new_user'
  username: string
  displayName: string | null
  avatar: string | null
  joinedAt: number
}

type GlobalFeedItem = FeedItem | NewUserItem

function timeAgo(unixSeconds: number): string {
  const diff = Date.now() - unixSeconds * 1000
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function FeedView() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<FeedTab>('for-you')
  const [feedItems, setFeedItems] = useState<FeedItem[]>([])
  const [feedLoading, setFeedLoading] = useState(true)
  const [globalItems, setGlobalItems] = useState<GlobalFeedItem[]>([])
  const [globalLoading, setGlobalLoading] = useState(true)
  const [pendingQuote, setPendingQuote] = useState<QuoteTarget | null>(null)
  const [voteTallies, setVoteTallies] = useState<Record<string, VoteTally>>({})
  const [myVoteCounts, setMyVoteCounts] = useState<Record<string, MyVoteCount>>({})
  const composerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  // Load the global "For you" feed from the DB
  useEffect(() => {
    if (!user || activeTab !== 'for-you') return
    async function loadGlobalFeed() {
      setGlobalLoading(true)
      try {
        const res = await fetch('/api/v1/feed/global', { credentials: 'include' })
        if (!res.ok) return
        const data = await res.json()
        const items: GlobalFeedItem[] = (data.items ?? []).map((item: any) => {
          if (item.type === 'article') {
            return {
              type: 'article' as const,
              id: item.nostrEventId,
              pubkey: item.pubkey,
              dTag: item.dTag,
              title: item.title,
              summary: item.summary,
              content: item.contentFree,
              isPaywalled: item.isPaywalled,
              pricePence: item.pricePence,
              gatePositionPct: item.gatePositionPct,
              publishedAt: item.publishedAt,
              tags: [],
            }
          } else if (item.type === 'note') {
            return {
              type: 'note' as const,
              id: item.nostrEventId,
              pubkey: item.pubkey,
              content: item.content,
              publishedAt: item.publishedAt,
              quotedEventId: item.quotedEventId,
              quotedEventKind: item.quotedEventKind,
              quotedExcerpt: item.quotedExcerpt,
              quotedTitle: item.quotedTitle,
              quotedAuthor: item.quotedAuthor,
            }
          } else {
            return item as NewUserItem
          }
        })
        setGlobalItems(items)

        const feedOnlyIds = items
          .filter((i): i is FeedItem => i.type !== 'new_user')
          .map(i => i.id)
        if (feedOnlyIds.length > 0) {
          const idsParam = feedOnlyIds.join(',')
          const [talliesRes, myVotesRes] = await Promise.all([
            fetch(`/api/v1/votes/tally?eventIds=${idsParam}`)
              .then(r => r.ok ? r.json() : { tallies: {} })
              .catch(() => ({ tallies: {} })),
            fetch(`/api/v1/votes/mine?eventIds=${idsParam}`, { credentials: 'include' })
              .then(r => r.ok ? r.json() : { voteCounts: {} })
              .catch(() => ({ voteCounts: {} })),
          ])
          setVoteTallies(talliesRes.tallies ?? {})
          setMyVoteCounts(myVotesRes.voteCounts ?? {})
        }
      } catch (err) { console.error('Global feed load error:', err) }
      finally { setGlobalLoading(false) }
    }
    loadGlobalFeed()
  }, [user, activeTab])

  useEffect(() => {
    if (!user || activeTab !== 'following') return
    async function loadFeed() {
      setFeedLoading(true)
      try {
        const ndk = getNdk(); await ndk.connect()
        if (activeTab === 'following') {
          const pks = await fetchFollowedPubkeys(user!.id)
          pks.push(user!.pubkey)
          const af = { authors: pks }
          const [articleEvents, noteEvents, deletionEvents, dbDeleted] = await Promise.all([
            ndk.fetchEvents({ kinds: [KIND_ARTICLE as NDKKind], limit: 30, ...af }),
            ndk.fetchEvents({ kinds: [KIND_NOTE as NDKKind], limit: 30, ...af }),
            ndk.fetchEvents({ kinds: [KIND_DELETION as NDKKind], limit: 100, ...af }),
            fetch(`/api/v1/articles/deleted?pubkeys=${pks.join(',')}`, { credentials: 'include' })
              .then(r => r.ok ? r.json() : { deletedEventIds: [], deletedCoords: [] })
              .catch(() => ({ deletedEventIds: [], deletedCoords: [] })),
          ])
          const deletedIds = new Set<string>(dbDeleted.deletedEventIds)
          const deletedCoords = new Set<string>(dbDeleted.deletedCoords)
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
          const allItems = [...articles, ...notes].sort((a, b) => b.publishedAt - a.publishedAt)
          setFeedItems(allItems)

          const eventIds = allItems.map(i => i.id)
          if (eventIds.length > 0) {
            const idsParam = eventIds.join(',')
            const [talliesRes, myVotesRes] = await Promise.all([
              fetch(`/api/v1/votes/tally?eventIds=${idsParam}`)
                .then(r => r.ok ? r.json() : { tallies: {} })
                .catch(() => ({ tallies: {} })),
              user
                ? fetch(`/api/v1/votes/mine?eventIds=${idsParam}`, { credentials: 'include' })
                    .then(r => r.ok ? r.json() : { voteCounts: {} })
                    .catch(() => ({ voteCounts: {} }))
                : Promise.resolve({ voteCounts: {} }),
            ])
            setVoteTallies(talliesRes.tallies ?? {})
            setMyVoteCounts(myVotesRes.voteCounts ?? {})
          }
        }
      } catch (err) { console.error('Feed load error:', err) }
      finally { setFeedLoading(false) }
    }
    loadFeed()
  }, [user, activeTab])

  const handleNotePublished = useCallback((note: NoteEvent) => {
    setPendingQuote(null)
    setFeedItems(prev => [note, ...prev])
    setGlobalItems(prev => [note, ...prev])
  }, [])

  const handleNoteDeleted = useCallback((id: string) => {
    setFeedItems(prev => prev.filter(i => i.id !== id))
    setGlobalItems(prev => prev.filter(i => i.type === 'new_user' || i.id !== id))
  }, [])

  const handleQuote = useCallback((target: QuoteTarget) => {
    setPendingQuote(target)
    window.scrollTo({ top: 0, behavior: 'smooth' })
    setTimeout(() => {
      composerRef.current?.querySelector('textarea')?.focus()
    }, 300)
  }, [])

  if (loading || !user) return <FeedSkeleton />

  return (
    <div className="mx-auto max-w-[600px] pt-16 lg:pt-0">

      {/* Sticky zone: composer + tabs */}
      <div className="sticky top-[53px] lg:top-0 z-10 bg-surface">
        <div ref={composerRef} className="px-6 pt-4">
          <NoteComposer
            quoteTarget={pendingQuote ?? undefined}
            onPublished={handleNotePublished}
            onClearQuote={() => setPendingQuote(null)}
          />
        </div>
        <div className="flex px-6 pt-1 border-b border-rule">
          <button
            onClick={() => setActiveTab('for-you')}
            className={`tab-feed ${activeTab === 'for-you' ? 'tab-feed-active' : ''}`}
          >
            For you
          </button>
          <button
            onClick={() => setActiveTab('following')}
            className={`tab-feed ${activeTab === 'following' ? 'tab-feed-active' : ''}`}
          >
            Following
          </button>
          <button
            onClick={() => setActiveTab('add')}
            className={`tab-feed ${activeTab === 'add' ? 'tab-feed-active' : ''}`}
          >
            Add
          </button>
        </div>
      </div>

      {/* Content zone */}
      <div className="pb-10 pt-6">
        {activeTab === 'add' ? (
          <AddPanel onFollowed={() => setActiveTab('following')} />
        ) : activeTab === 'for-you' ? (
          globalLoading ? <InlineSkeleton /> : globalItems.length === 0 ? (
            <div className="py-20 text-center px-6">
              <p className="text-ui-sm text-content-muted">Nothing here yet.</p>
            </div>
          ) : (
            <div className="px-6">
              {globalItems.map((item, idx) => {
                if (item.type === 'new_user') {
                  return <NewUserCard key={`new-user-${item.username}-${item.joinedAt}`} item={item} />
                } else if (item.type === 'article') {
                  return (
                    <div key={item.id} className={idx > 0 ? 'mt-[10px]' : ''}>
                      <ArticleCard article={item} onQuote={handleQuote} voteTally={voteTallies[item.id]} myVoteCounts={myVoteCounts[item.id]} />
                    </div>
                  )
                } else {
                  return <NoteCard key={item.id} note={item} onDeleted={handleNoteDeleted} onQuote={handleQuote} voteTally={voteTallies[item.id]} myVoteCounts={myVoteCounts[item.id]} />
                }
              })}
            </div>
          )
        ) : feedLoading ? (
          <InlineSkeleton />
        ) : feedItems.length === 0 ? (
          <div className="py-20 text-center px-6">
            <p className="text-ui-sm text-content-muted">
              Nothing here yet. Use the Add tab to follow writers.
            </p>
          </div>
        ) : (
          <div className="px-6">
            {feedItems.map((item, idx) => item.type === 'article'
              ? (
                <div key={item.id} className={idx > 0 ? 'mt-[10px]' : ''}>
                  <ArticleCard article={item} onQuote={handleQuote} voteTally={voteTallies[item.id]} myVoteCounts={myVoteCounts[item.id]} />
                </div>
              )
              : <NoteCard key={item.id} note={item} onDeleted={handleNoteDeleted} onQuote={handleQuote} voteTally={voteTallies[item.id]} myVoteCounts={myVoteCounts[item.id]} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// New user card
// =============================================================================

function NewUserCard({ item }: { item: NewUserItem }) {
  const name = item.displayName ?? item.username ?? 'Someone'
  const initial = name[0].toUpperCase()
  return (
    <div className="flex items-center gap-3 py-3">
      {item.avatar ? (
        <img src={item.avatar} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
      ) : (
        <span className="flex h-7 w-7 items-center justify-center bg-avatar-bg text-[10px] font-medium text-content-muted rounded-full flex-shrink-0">
          {initial}
        </span>
      )}
      <p className="text-ui-xs text-content-muted flex-1 min-w-0">
        {item.username ? (
          <Link href={`/${item.username}`} className="font-medium text-content-primary hover:underline">
            {name}
          </Link>
        ) : (
          <span className="font-medium text-content-primary">{name}</span>
        )}
        {' '}joined the platform
      </p>
      <span className="text-ui-xs text-content-faint flex-shrink-0">{timeAgo(item.joinedAt)}</span>
    </div>
  )
}

// =============================================================================
// Add panel
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
      <div className="flex gap-0 mb-4 border-b border-rule">
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
            className="w-full bg-card px-4 py-3 text-ui-sm text-content-primary placeholder:text-content-faint focus:outline-none transition-colors mb-4"
          />

          {searching && (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <div key={i} className="h-14 animate-pulse bg-surface-deep" />)}
            </div>
          )}

          {!searching && results.length === 0 && query.trim().length >= 2 && (
            <p className="text-ui-sm text-content-muted text-center py-8">No writers found.</p>
          )}

          {!searching && results.map(w => (
            <div key={w.id} className="flex items-center gap-3 py-3 border-b border-rule last:border-b-0">
              {w.avatar ? (
                <img src={w.avatar} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
              ) : (
                <span className="flex h-9 w-9 items-center justify-center bg-avatar-bg text-xs font-medium text-content-muted flex-shrink-0 rounded-full">
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
            className="w-full bg-card px-4 py-3 text-ui-sm text-content-primary placeholder:text-content-faint focus:outline-none transition-colors mb-4"
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
    <div className="mx-auto max-w-[600px] pt-16 lg:pt-0 px-6 py-10 space-y-[10px]">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-card p-5">
          <div className="h-3 w-24 animate-pulse bg-surface-deep mb-4" />
          <div className="h-5 w-3/4 animate-pulse bg-surface-deep mb-3" />
          <div className="h-3 w-full animate-pulse bg-surface-deep" />
        </div>
      ))}
    </div>
  )
}

function InlineSkeleton() {
  return (
    <div className="px-6 pt-1 space-y-[10px]">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-card p-5">
          <div className="h-3 w-24 animate-pulse bg-surface-deep mb-4" />
          <div className="h-5 w-3/4 animate-pulse bg-surface-deep mb-3" />
          <div className="h-3 w-full animate-pulse bg-surface-deep" />
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
