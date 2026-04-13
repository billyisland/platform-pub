'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { ArticleCard } from '../feed/ArticleCard'
import { NoteCard } from '../feed/NoteCard'
import { NoteComposer } from '../feed/NoteComposer'
import type { FeedItem, NoteEvent } from '../../lib/ndk'
import type { QuoteTarget } from '../../lib/publishNote'
import { feed as feedApi, votes as votesApi, bookmarks as bookmarksApi, type VoteTally, type MyVoteCount, type FeedReach } from '../../lib/api'

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

function getStoredReach(): FeedReach {
  if (typeof window === 'undefined') return 'explore'
  return (localStorage.getItem('feedReach') as FeedReach) || 'explore'
}

export function FeedView() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [reach, setReach] = useState<FeedReach>(getStoredReach)
  const [globalItems, setGlobalItems] = useState<GlobalFeedItem[]>([])
  const [globalLoading, setGlobalLoading] = useState(true)
  const [globalError, setGlobalError] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [pendingQuote, setPendingQuote] = useState<QuoteTarget | null>(null)
  const [voteTallies, setVoteTallies] = useState<Record<string, VoteTally>>({})
  const [myVoteCounts, setMyVoteCounts] = useState<Record<string, MyVoteCount>>({})
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set())
  const composerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  function handleReachChange(newReach: FeedReach) {
    setReach(newReach)
    localStorage.setItem('feedReach', newReach)
    setRetryKey(k => k + 1)
  }

  // Load feed from the unified endpoint
  useEffect(() => {
    if (!user) return
    async function loadFeed() {
      setGlobalLoading(true)
      setGlobalError(false)
      try {
        const data = await feedApi.get(reach)
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
              topicTags: item.tags ?? [],
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
          const [talliesRes, myVotesRes, bmRes] = await Promise.all([
            votesApi.getTallies(feedOnlyIds).catch(() => ({ tallies: {} })),
            votesApi.getMyVotes(feedOnlyIds).catch(() => ({ voteCounts: {} })),
            bookmarksApi.ids().catch(() => ({ eventIds: [] })),
          ])
          setVoteTallies(talliesRes.tallies ?? {})
          setMyVoteCounts(myVotesRes.voteCounts ?? {})
          setBookmarkedIds(new Set(bmRes.eventIds ?? []))
        }
      } catch (err) { console.error('Feed load error:', err); setGlobalError(true) }
      finally { setGlobalLoading(false) }
    }
    loadFeed()
  }, [user, reach, retryKey])

  const handleNotePublished = useCallback((note: NoteEvent) => {
    setPendingQuote(null)
    setGlobalItems(prev => [note, ...prev])
  }, [])

  const handleNoteDeleted = useCallback((id: string) => {
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
    <div className="mx-auto max-w-feed pt-0">

      {/* Composer */}
      <div className="sticky top-[60px] z-10 bg-white">
        <div ref={composerRef} className="px-6 pt-4 pb-4">
          <NoteComposer
            quoteTarget={pendingQuote ?? undefined}
            onPublished={handleNotePublished}
            onClearQuote={() => setPendingQuote(null)}
          />
        </div>

        <div className="h-3" />
      </div>

      {/* Feed */}
      <div className="pb-10">
        {globalLoading ? <InlineSkeleton /> : globalError ? (
          <div className="py-20 text-center px-6">
            <p className="text-ui-sm text-grey-600 mb-4">Failed to load feed.</p>
            <button
              onClick={() => setRetryKey(k => k + 1)}
              className="text-[13px] font-mono text-black underline hover:opacity-70 transition-opacity"
            >
              Try again
            </button>
          </div>
        ) : globalItems.length === 0 ? (
          <div className="py-20 text-center px-6">
            <p className="text-ui-sm text-grey-600">Nothing here yet.</p>
          </div>
        ) : (
          <div className="px-6">
            {globalItems.map((item) => {
              if (item.type === 'new_user') {
                return <NewUserCard key={`new-user-${item.username}-${item.joinedAt}`} item={item} />
              } else if (item.type === 'article') {
                return <ArticleCard key={item.id} article={item} onQuote={handleQuote} voteTally={voteTallies[item.id]} myVoteCounts={myVoteCounts[item.id]} isBookmarked={bookmarkedIds.has(item.id)} />
              } else {
                return <NoteCard key={item.id} note={item} onDeleted={handleNoteDeleted} onQuote={handleQuote} voteTally={voteTallies[item.id]} myVoteCounts={myVoteCounts[item.id]} />
              }
            })}
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
        <img src={item.avatar} alt="" className="h-7 w-7  object-cover flex-shrink-0" />
      ) : (
        <span className="flex h-7 w-7 items-center justify-center bg-grey-100 text-[12px] font-medium text-grey-400  flex-shrink-0">
          {initial}
        </span>
      )}
      <p className="text-ui-xs text-grey-400 flex-1 min-w-0">
        {item.username ? (
          <Link href={`/${item.username}`} className="font-medium text-black hover:underline">
            {name}
          </Link>
        ) : (
          <span className="font-medium text-black">{name}</span>
        )}
        {' '}joined the platform
      </p>
      <span className="text-ui-xs text-grey-600 flex-shrink-0">{timeAgo(item.joinedAt)}</span>
    </div>
  )
}


// =============================================================================
// Skeletons
// =============================================================================

function FeedSkeleton() {
  return (
    <div className="mx-auto max-w-feed pt-16 lg:pt-0 px-4 sm:px-6 py-10 space-y-[10px]">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-white bg-grey-100 p-5">
          <div className="h-3 w-24 animate-pulse bg-grey-100 mb-4" />
          <div className="h-5 w-3/4 animate-pulse bg-grey-100 mb-3" />
          <div className="h-3 w-full animate-pulse bg-grey-100" />
        </div>
      ))}
    </div>
  )
}

function InlineSkeleton() {
  return (
    <div className="px-6 pt-1 space-y-[10px]">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-white bg-grey-100 p-5">
          <div className="h-3 w-24 animate-pulse bg-grey-100 mb-4" />
          <div className="h-5 w-3/4 animate-pulse bg-grey-100 mb-3" />
          <div className="h-3 w-full animate-pulse bg-grey-100" />
        </div>
      ))}
    </div>
  )
}

