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
import { feed as feedApi, votes as votesApi, type VoteTally, type MyVoteCount } from '../../lib/api'

type FeedTab = 'for-you' | 'following'

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
        const data = await feedApi.global()
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
          const [talliesRes, myVotesRes] = await Promise.all([
            votesApi.getTallies(feedOnlyIds).catch(() => ({ tallies: {} })),
            votesApi.getMyVotes(feedOnlyIds).catch(() => ({ voteCounts: {} })),
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
        const data = await feedApi.following()
        const items: FeedItem[] = (data.items ?? []).map((item: any) => {
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
          } else {
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
          }
        })
        setFeedItems(items)

        const eventIds = items.map(i => i.id)
        if (eventIds.length > 0) {
          const [talliesRes, myVotesRes] = await Promise.all([
            votesApi.getTallies(eventIds).catch(() => ({ tallies: {} })),
            votesApi.getMyVotes(eventIds).catch(() => ({ voteCounts: {} })),
          ])
          setVoteTallies(talliesRes.tallies ?? {})
          setMyVoteCounts(myVotesRes.voteCounts ?? {})
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
    <div className="mx-auto max-w-feed pt-0">

      {/* Sticky zone: composer + tabs */}
      <div className="sticky top-[56px] z-10 bg-white">
        <div ref={composerRef} className="px-6 pt-4">
          <NoteComposer
            quoteTarget={pendingQuote ?? undefined}
            onPublished={handleNotePublished}
            onClearQuote={() => setPendingQuote(null)}
          />
        </div>
        <div className="flex px-6 pt-1 border-b-2 border-grey-200">
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
        </div>
      </div>

      {/* Content zone */}
      <div className="pb-10 pt-6">
        {activeTab === 'for-you' ? (
          globalLoading ? <InlineSkeleton /> : globalItems.length === 0 ? (
            <div className="py-20 text-center px-6">
              <p className="text-ui-sm text-grey-400">Nothing here yet.</p>
            </div>
          ) : (
            <div className="px-6">
              {globalItems.map((item, idx) => {
                if (item.type === 'new_user') {
                  return <NewUserCard key={`new-user-${item.username}-${item.joinedAt}`} item={item} />
                } else if (item.type === 'article') {
                  return (
                    <div key={item.id} className="">
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
            <p className="text-ui-sm text-grey-400">
              Nothing here yet. Search for writers to follow.
            </p>
          </div>
        ) : (
          <div className="px-6">
            {feedItems.map((item, idx) => item.type === 'article'
              ? (
                <div key={item.id} className="">
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
        <span className="flex h-7 w-7 items-center justify-center bg-grey-100 text-[12px] font-medium text-grey-400 rounded-full flex-shrink-0">
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
      <span className="text-ui-xs text-grey-300 flex-shrink-0">{timeAgo(item.joinedAt)}</span>
    </div>
  )
}


// =============================================================================
// Skeletons
// =============================================================================

function FeedSkeleton() {
  return (
    <div className="mx-auto max-w-feed pt-16 lg:pt-0 px-6 py-10 space-y-[10px]">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-white border border-grey-100 p-5">
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
        <div key={i} className="bg-white border border-grey-100 p-5">
          <div className="h-3 w-24 animate-pulse bg-grey-100 mb-4" />
          <div className="h-5 w-3/4 animate-pulse bg-grey-100 mb-3" />
          <div className="h-3 w-full animate-pulse bg-grey-100" />
        </div>
      ))}
    </div>
  )
}

