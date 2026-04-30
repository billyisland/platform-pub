'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { feed as feedApi } from '../../lib/api'
import type { FeedItem, ExternalFeedItem } from '../../lib/ndk'
import { Vessel } from './Vessel'
import { VesselCard, NewUserVesselCard } from './VesselCard'

const FLOOR = '#F0EFEB' // grey-100 per Step 1 / Colour tokens committed

// Slice 1: one hardcoded vessel, fetching from /api/v1/timeline.
// The feeds API arrives in slice 3.

interface NewUserItem {
  type: 'new_user'
  username: string
  displayName: string | null
  avatar: string | null
  joinedAt: number
}

type WorkspaceItem = FeedItem | NewUserItem

function mapApiItem(item: any): WorkspaceItem | null {
  if (item.type === 'article') {
    return {
      type: 'article',
      id: item.nostrEventId,
      pubkey: item.pubkey,
      dTag: item.dTag,
      title: item.title,
      summary: item.summary,
      content: item.contentFree ?? '',
      isPaywalled: item.isPaywalled,
      pricePence: item.pricePence,
      gatePositionPct: item.gatePositionPct,
      publishedAt: item.publishedAt,
      tags: [],
      topicTags: item.tags ?? [],
      pipStatus: item.pipStatus,
      sizeTier: item.sizeTier,
    }
  }
  if (item.type === 'note') {
    return {
      type: 'note',
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
  }
  if (item.type === 'external') {
    return {
      type: 'external',
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
  }
  if (item.type === 'new_user') {
    return {
      type: 'new_user',
      username: item.username,
      displayName: item.displayName ?? null,
      avatar: item.avatar ?? null,
      joinedAt: item.joinedAt,
    }
  }
  return null
}

export function WorkspaceView() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [items, setItems] = useState<WorkspaceItem[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setStatus('loading')
    feedApi
      .get('explore')
      .then((data) => {
        if (cancelled) return
        const mapped = (data.items ?? [])
          .map(mapApiItem)
          .filter((x: WorkspaceItem | null): x is WorkspaceItem => x !== null)
        setItems(mapped)
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Workspace feed load error:', err)
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [user])

  if (loading || !user) {
    return <Floor />
  }

  return (
    <Floor>
      <div className="flex justify-center pt-12">
        <Vessel name="Founder's feed">
          {status === 'loading' && <Hint>LOADING…</Hint>}
          {status === 'error' && <Hint>COULDN&rsquo;T LOAD FEED</Hint>}
          {status === 'ready' && items.length === 0 && <Hint>NO ITEMS</Hint>}
          {status === 'ready' &&
            items.slice(0, 12).map((item) =>
              item.type === 'new_user' ? (
                <NewUserVesselCard
                  key={`new-user-${item.username}-${item.joinedAt}`}
                  item={item}
                />
              ) : (
                <VesselCard key={item.id} item={item} />
              ),
            )}
        </Vessel>
      </div>
    </Floor>
  )
}

function Floor({ children }: { children?: React.ReactNode }) {
  return (
    <div
      style={{ background: FLOOR, minHeight: 'calc(100vh - 60px)' }}
      className="-mx-4 sm:-mx-6"
    >
      {children}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono text-[11px] uppercase tracking-[0.06em] py-6 text-center"
      style={{ color: '#9C9A94' }}
    >
      {children}
    </div>
  )
}
