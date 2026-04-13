'use client'

import { useState, useEffect, useCallback } from 'react'
import { ArticleCard } from '../feed/ArticleCard'
import { ProfileDriveCard } from './ProfileDriveCard'
import { VoteControls } from '../ui/VoteControls'
import type { WriterProfile, VoteTally, MyVoteCount, PledgeDrive } from '../../lib/api'
import type { ArticleEvent } from '../../lib/ndk'
import type { QuoteTarget } from '../../lib/publishNote'

interface DbArticle {
  id: string
  nostrEventId: string
  dTag: string
  title: string
  slug: string
  summary: string | null
  wordCount: number | null
  isPaywalled: boolean
  publishedAt: string | null
  pinnedOnProfile: boolean
  profilePinOrder: number
}

type WorkItem =
  | { kind: 'article'; publishedAt: string; pinned: boolean; pinOrder: number; data: DbArticle }
  | { kind: 'drive'; publishedAt: string; pinned: boolean; pinOrder: number; data: PledgeDrive }

interface WorkTabProps {
  username: string
  writer: WriterProfile
  isOwnProfile: boolean
  onQuote?: (target: QuoteTarget) => void
}

export function WorkTab({ username, writer, isOwnProfile, onQuote }: WorkTabProps) {
  const [items, setItems] = useState<WorkItem[]>([])
  const [loading, setLoading] = useState(true)
  const [voteTallies, setVoteTallies] = useState<Record<string, VoteTally>>({})
  const [myVoteCounts, setMyVoteCounts] = useState<Record<string, MyVoteCount>>({})

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [articlesRes, drivesRes] = await Promise.all([
          fetch(`/api/v1/writers/${username}/articles?limit=50`, { credentials: 'include' }),
          fetch(`/api/v1/drives/by-user/${writer.id}`, { credentials: 'include' }),
        ])

        const work: WorkItem[] = []

        if (articlesRes.ok) {
          const data = await articlesRes.json()
          for (const a of (data.articles ?? []) as DbArticle[]) {
            if (a.publishedAt) {
              work.push({
                kind: 'article',
                publishedAt: a.publishedAt,
                pinned: a.pinnedOnProfile,
                pinOrder: a.profilePinOrder,
                data: a,
              })
            }
          }
        }

        if (drivesRes.ok) {
          const data = await drivesRes.json()
          for (const d of (data.drives ?? []) as PledgeDrive[]) {
            work.push({
              kind: 'drive',
              publishedAt: d.createdAt,
              pinned: d.pinned,
              pinOrder: 0,
              data: d,
            })
          }
        }

        setItems(work)

        // Fetch vote tallies for articles
        const eventIds = work
          .filter(i => i.kind === 'article')
          .map(i => (i.data as DbArticle).nostrEventId)
        if (eventIds.length > 0) {
          const idsParam = eventIds.join(',')
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
      } catch { /* silently fail */ }
      finally { setLoading(false) }
    }
    load()
  }, [username, writer.id])

  const handleTogglePin = useCallback(async (articleId: string) => {
    try {
      const res = await fetch(`/api/v1/articles/${articleId}/pin`, {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok) {
        const { pinned } = await res.json()
        setItems(prev => prev.map(item =>
          item.kind === 'article' && (item.data as DbArticle).id === articleId
            ? { ...item, pinned, data: { ...item.data as DbArticle, pinnedOnProfile: pinned } }
            : item
        ))
      }
    } catch { /* silently fail */ }
  }, [])

  if (loading) {
    return <div className="py-10 text-center text-ui-sm text-grey-300">Loading...</div>
  }

  if (items.length === 0) {
    return <p className="text-ui-sm text-grey-400 py-10">No articles yet.</p>
  }

  const pinned = items
    .filter(i => i.pinned)
    .sort((a, b) => a.pinOrder - b.pinOrder)

  const unpinned = items
    .filter(i => !i.pinned)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())

  function renderItem(item: WorkItem) {
    if (item.kind === 'article') {
      const a = item.data as DbArticle
      const articleEvent: ArticleEvent & { type: 'article' } = {
        type: 'article',
        id: a.nostrEventId,
        pubkey: writer.pubkey,
        dTag: a.dTag,
        title: a.title,
        summary: a.summary ?? '',
        content: '',
        publishedAt: a.publishedAt ? Math.floor(new Date(a.publishedAt).getTime() / 1000) : 0,
        tags: [],
        isPaywalled: a.isPaywalled,
      }
      return (
        <div key={a.id}>
          <ArticleCard
            article={articleEvent}
            onQuote={onQuote}
            voteTally={voteTallies[a.nostrEventId]}
            myVoteCounts={myVoteCounts[a.nostrEventId]}
          />
          {isOwnProfile && (
            <div className="px-6 pb-3 -mt-1">
              <button
                onClick={() => handleTogglePin(a.id)}
                className="text-ui-xs text-grey-300 hover:text-black transition-colors"
              >
                {a.pinnedOnProfile ? 'Unpin from profile' : 'Pin to profile'}
              </button>
            </div>
          )}
        </div>
      )
    }

    const d = item.data as PledgeDrive
    return <ProfileDriveCard key={d.id} drive={d} />
  }

  return (
    <div>
      {/* Pinned section */}
      {pinned.length > 0 && (
        <>
          <h3 className="label-ui text-grey-300 mb-4">
            Pinned
          </h3>
          <div className="space-y-3 mb-8">
            {pinned.map(renderItem)}
          </div>
          <div className="rule-inset mb-8" />
        </>
      )}

      {/* Chronological feed */}
      <div className="space-y-3">
        {unpinned.map(renderItem)}
      </div>
    </div>
  )
}
