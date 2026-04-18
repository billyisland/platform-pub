'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { ArticleCard } from '../feed/ArticleCard'
import { NoteCard } from '../feed/NoteCard'
import { ExternalCard } from '../feed/ExternalCard'
import { SubscribeInput } from '../feed/SubscribeInput'
import type { FeedItem, NoteEvent, ExternalFeedItem, ArticleEvent } from '../../lib/ndk'
import type { QuoteTarget } from '../../lib/publishNote'
import { feed as feedApi, votes as votesApi, bookmarks as bookmarksApi, type VoteTally, type MyVoteCount, type FeedReach } from '../../lib/api'
import { useCompose } from '../../stores/compose'

interface NewUserItem {
  type: 'new_user'
  username: string
  displayName: string | null
  avatar: string | null
  joinedAt: number
}

type GlobalFeedItem = FeedItem | NewUserItem | ExternalFeedItem

// Layout block — either a single full-width item or a side-by-side pair of
// brief articles. `leadsBriefRun` marks the first block in a contiguous run
// of briefs so we can insert the spec's 72px zone-break above it.
type FeedBlock =
  | { kind: 'single'; item: GlobalFeedItem; leadsBriefRun: boolean }
  | { kind: 'brief-pair'; items: [ArticleEvent & { type: 'article' }, ArticleEvent & { type: 'article' }]; leadsBriefRun: boolean }

function isBrief(item: GlobalFeedItem): item is ArticleEvent & { type: 'article' } {
  return item.type === 'article' && (item as ArticleEvent).sizeTier === 'brief'
}

function layoutBlocks(items: GlobalFeedItem[]): FeedBlock[] {
  const blocks: FeedBlock[] = []
  let i = 0
  while (i < items.length) {
    if (isBrief(items[i])) {
      // Collect contiguous brief run, then pair them two-up with remainder full-width.
      const run: (ArticleEvent & { type: 'article' })[] = []
      while (i < items.length && isBrief(items[i])) {
        run.push(items[i] as ArticleEvent & { type: 'article' })
        i++
      }
      for (let k = 0; k < run.length; k += 2) {
        const leadsRun = k === 0
        if (k + 1 < run.length) {
          blocks.push({ kind: 'brief-pair', items: [run[k], run[k + 1]], leadsBriefRun: leadsRun })
        } else {
          blocks.push({ kind: 'single', item: run[k], leadsBriefRun: leadsRun })
        }
      }
    } else {
      blocks.push({ kind: 'single', item: items[i], leadsBriefRun: false })
      i++
    }
  }
  return blocks
}

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
  const failureTimestampsRef = useRef<number[]>([])
  const [showGatewayHint, setShowGatewayHint] = useState(false)
  const [voteTallies, setVoteTallies] = useState<Record<string, VoteTally>>({})
  const [myVoteCounts, setMyVoteCounts] = useState<Record<string, MyVoteCount>>({})
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set())
  const openCompose = useCompose((s) => s.open)
  const setOnPublished = useCompose((s) => s.setOnPublished)

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
              pipStatus: item.pipStatus,
              sizeTier: item.sizeTier,
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
              pipStatus: item.pipStatus,
            }
          } else if (item.type === 'external') {
            return {
              type: 'external' as const,
              id: item.id,
              sourceProtocol: item.sourceProtocol,
              sourceItemUri: item.sourceItemUri,
              authorName: item.authorName,
              authorHandle: item.authorHandle,
              authorAvatarUrl: item.authorAvatarUrl,
              authorUri: item.authorUri,
              contentText: item.contentText,
              contentHtml: item.contentHtml,
              title: item.title,
              summary: item.summary,
              media: item.media ?? [],
              publishedAt: item.publishedAt,
              sourceName: item.sourceName,
              sourceAvatar: item.sourceAvatar,
              pipStatus: item.pipStatus ?? 'unknown',
            } as ExternalFeedItem
          } else {
            return item as NewUserItem
          }
        })
        setGlobalItems(items)

        const feedOnlyIds = items
          .filter((i): i is FeedItem | ExternalFeedItem => i.type !== 'new_user')
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
      } catch (err) {
        console.error('Feed load error:', err)
        setGlobalError(true)
        const now = Date.now()
        const recent = failureTimestampsRef.current.filter(t => now - t < 60_000)
        recent.push(now)
        failureTimestampsRef.current = recent
        setShowGatewayHint(recent.length >= 3)
      }
      finally { setGlobalLoading(false) }
    }
    loadFeed()
  }, [user, reach, retryKey])

  const handleNotePublished = useCallback((note: NoteEvent) => {
    setGlobalItems(prev => [note, ...prev])
  }, [])

  // Register the callback so the compose overlay can prepend notes to this feed
  useEffect(() => {
    setOnPublished(handleNotePublished)
    return () => setOnPublished(null)
  }, [handleNotePublished, setOnPublished])

  const handleNoteDeleted = useCallback((id: string) => {
    setGlobalItems(prev => prev.filter(i => i.type === 'new_user' || i.id !== id))
  }, [])

  const handleQuote = useCallback((target: QuoteTarget) => {
    openCompose('reply', target)
  }, [openCompose])

  if (loading || !user) return <FeedSkeleton />

  return (
    <div className="mx-auto max-w-feed pt-0">

      {/* Subscribe input */}
      <div className="sticky top-[60px] z-10 bg-white">
        <div className="px-6 pt-4 pb-4">
          <SubscribeInput onSubscribed={() => setRetryKey(k => k + 1)} />
        </div>
      </div>

      {/* Feed */}
      <div className="pb-10">
        {globalLoading ? <InlineSkeleton /> : globalError ? (
          <FeedErrorState onRetry={() => setRetryKey(k => k + 1)} showGatewayHint={showGatewayHint} />
        ) : globalItems.length === 0 ? (
          reach === 'following' ? (
            <FilteredEmptyState onClear={() => handleReachChange('explore')} />
          ) : (
            <ZeroState />
          )
        ) : (
          <div className="px-6 pt-[48px]">
            {layoutBlocks(globalItems).map((block, blockIdx) => {
              const marginTop = blockIdx === 0 ? 0 : (block.leadsBriefRun ? 72 : 40)
              if (block.kind === 'brief-pair') {
                const [a, b] = block.items
                return (
                  <div key={`pair-${a.id}-${b.id}`} style={{ marginTop }} className="grid grid-cols-2 gap-x-[40px]">
                    <ArticleCard article={a} onQuote={handleQuote} voteTally={voteTallies[a.id]} myVoteCounts={myVoteCounts[a.id]} isBookmarked={bookmarkedIds.has(a.id)} twoUp />
                    <ArticleCard article={b} onQuote={handleQuote} voteTally={voteTallies[b.id]} myVoteCounts={myVoteCounts[b.id]} isBookmarked={bookmarkedIds.has(b.id)} twoUp />
                  </div>
                )
              }
              const item = block.item
              if (item.type === 'new_user') {
                return (
                  <div key={`new-user-${item.username}-${item.joinedAt}`} style={{ marginTop }}>
                    <NewUserCard item={item} />
                  </div>
                )
              }
              return (
                <div key={item.id} style={{ marginTop }}>
                  {item.type === 'article' ? (
                    <ArticleCard article={item} onQuote={handleQuote} voteTally={voteTallies[item.id]} myVoteCounts={myVoteCounts[item.id]} isBookmarked={bookmarkedIds.has(item.id)} />
                  ) : item.type === 'external' ? (
                    <ExternalCard item={item as ExternalFeedItem} />
                  ) : (
                    <NoteCard note={item} onDeleted={handleNoteDeleted} onQuote={handleQuote} voteTally={voteTallies[item.id]} myVoteCounts={myVoteCounts[item.id]} />
                  )}
                </div>
              )
            })}
            <EndOfFeed />
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

// =============================================================================
// End-of-feed / zero / empty-filter / error states
// =============================================================================

function scrollToSubscribe() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
  // Focus the input after the scroll settles.
  window.setTimeout(() => {
    document.getElementById('feed-subscribe-input')?.focus()
  }, 300)
}

function EndOfFeed() {
  return (
    <div className="pt-12 pb-12 text-center">
      <p className="label-ui text-grey-400">END OF FEED</p>
      <div className="mx-auto mt-3 h-[4px] w-12 bg-crimson" />
      <button
        onClick={scrollToSubscribe}
        className="mt-6 label-ui text-grey-600 hover:text-black transition-colors"
      >
        SUBSCRIBE TO MORE →
      </button>
    </div>
  )
}

function ZeroState() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="max-w-[60%] text-center">
        <p className="font-serif italic text-[32px] leading-[1.15] tracking-tight text-black">
          Nothing here yet — which is fine.
        </p>
        <p className="mt-6 text-[15px] text-grey-600 leading-[1.55]">
          The feed fills up as you follow people and publications. Start{' '}
          <button
            onClick={scrollToSubscribe}
            className="underline hover:text-black transition-colors"
          >
            above
          </button>
          .
        </p>
        <p className="mt-9 label-ui text-grey-400">
          TRY: A BLUESKY HANDLE · AN RSS URL · AN NPUB · A PUBLICATION NAME
        </p>
      </div>
    </div>
  )
}

function FilteredEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-6">
      <div className="text-center">
        <p className="label-ui text-grey-600">NO ITEMS MATCH THIS FILTER</p>
        <button
          onClick={onClear}
          className="mt-4 label-ui text-grey-600 hover:text-black underline transition-colors"
        >
          CLEAR FILTER
        </button>
      </div>
    </div>
  )
}

function FeedErrorState({ onRetry, showGatewayHint }: { onRetry: () => void; showGatewayHint: boolean }) {
  return (
    <div className="flex items-start justify-center px-6 pt-[33vh] pb-20">
      <div className="text-center">
        <p className="text-[15px] text-black leading-[1.55]">Couldn&rsquo;t load the feed.</p>
        <button
          onClick={onRetry}
          className="mt-6 label-ui text-grey-600 hover:text-black underline transition-colors"
        >
          RETRY
        </button>
        {showGatewayHint && (
          <p className="mt-6 text-[14px] text-grey-600 leading-[1.55] max-w-[360px] mx-auto">
            The gateway may be down. This isn&rsquo;t a sync issue on your end.
          </p>
        )}
      </div>
    </div>
  )
}

