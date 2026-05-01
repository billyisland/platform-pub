'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { workspaceFeeds as workspaceFeedsApi, type WorkspaceFeed } from '../../lib/api'
import type { FeedItem, ExternalFeedItem } from '../../lib/ndk'
import { Vessel } from './Vessel'
import { VesselCard, NewUserVesselCard } from './VesselCard'
import { ForallMenu, type ForallAction } from './ForallMenu'
import { Composer } from './Composer'
import { NewFeedPrompt } from './NewFeedPrompt'

const FLOOR = '#F0EFEB' // grey-100 per Step 1 / Colour tokens committed
const DEFAULT_FEED_NAME = "Founder's feed"

// Slice 3: per-feed vessels backed by /api/v1/feeds. Empty source sets fall
// back to an explore stream until source-set wiring lands.

interface NewUserItem {
  type: 'new_user'
  username: string
  displayName: string | null
  avatar: string | null
  joinedAt: number
}

type WorkspaceItem = FeedItem | NewUserItem

interface VesselState {
  feed: WorkspaceFeed
  items: WorkspaceItem[]
  status: 'loading' | 'ready' | 'error'
}

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
  const [vessels, setVessels] = useState<VesselState[]>([])
  const [bootstrap, setBootstrap] = useState<'loading' | 'ready' | 'error'>('loading')
  const [composerOpen, setComposerOpen] = useState(false)
  const [newFeedOpen, setNewFeedOpen] = useState(false)

  const loadVesselItems = useCallback(async (feed: WorkspaceFeed) => {
    setVessels((prev) =>
      prev.map((v) => (v.feed.id === feed.id ? { ...v, status: 'loading' } : v)),
    )
    try {
      const data = await workspaceFeedsApi.items(feed.id)
      const mapped = (data.items ?? [])
        .map(mapApiItem)
        .filter((x: WorkspaceItem | null): x is WorkspaceItem => x !== null)
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feed.id ? { feed: data.feed, items: mapped, status: 'ready' } : v,
        ),
      )
    } catch (err) {
      console.error('Vessel items load error:', err)
      setVessels((prev) =>
        prev.map((v) => (v.feed.id === feed.id ? { ...v, status: 'error' } : v)),
      )
    }
  }, [])

  function refreshAll() {
    vessels.forEach((v) => void loadVesselItems(v.feed))
  }

  function handleForallAction(key: ForallAction) {
    if (key === 'new-note') {
      setComposerOpen(true)
      return
    }
    if (key === 'new-feed') {
      setNewFeedOpen(true)
      return
    }
    console.log(`[workspace] ${key} — not yet wired`)
  }

  async function handleCreateFeed(name: string) {
    const { feed } = await workspaceFeedsApi.create(name)
    setVessels((prev) => [...prev, { feed, items: [], status: 'loading' }])
    setNewFeedOpen(false)
    void loadVesselItems(feed)
  }

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  // Bootstrap: list feeds, seed the default if none exist, fetch items per
  // vessel. Re-runs only when the authenticated user changes.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setBootstrap('loading')
    ;(async () => {
      try {
        let { feeds: list } = await workspaceFeedsApi.list()
        if (list.length === 0) {
          const { feed } = await workspaceFeedsApi.create(DEFAULT_FEED_NAME)
          list = [feed]
        }
        if (cancelled) return
        const initial: VesselState[] = list.map((feed) => ({
          feed,
          items: [],
          status: 'loading',
        }))
        setVessels(initial)
        setBootstrap('ready')
        for (const feed of list) {
          if (cancelled) return
          // Fire-and-forget per vessel — no need to serialise.
          void loadVesselItems(feed)
        }
      } catch (err) {
        if (cancelled) return
        console.error('Workspace bootstrap error:', err)
        setBootstrap('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, loadVesselItems])

  if (loading || !user) {
    return <Floor />
  }

  return (
    <Floor>
      <div className="flex flex-wrap justify-center gap-8 pt-12 px-6">
        {bootstrap === 'loading' && <Hint>BOOTSTRAPPING WORKSPACE…</Hint>}
        {bootstrap === 'error' && <Hint>COULDN&rsquo;T LOAD WORKSPACE</Hint>}
        {bootstrap === 'ready' &&
          vessels.map((v) => (
            <Vessel key={v.feed.id} name={v.feed.name}>
              {v.status === 'loading' && <Hint>LOADING…</Hint>}
              {v.status === 'error' && <Hint>COULDN&rsquo;T LOAD FEED</Hint>}
              {v.status === 'ready' && v.items.length === 0 && <Hint>NO ITEMS</Hint>}
              {v.status === 'ready' &&
                v.items.slice(0, 12).map((item) =>
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
          ))}
      </div>
      <ForallMenu onAction={handleForallAction} />
      <Composer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onPublished={refreshAll}
      />
      <NewFeedPrompt
        open={newFeedOpen}
        onClose={() => setNewFeedOpen(false)}
        onCreate={handleCreateFeed}
      />
    </Floor>
  )
}

function Floor({ children }: { children?: React.ReactNode }) {
  return (
    <div style={{ background: FLOOR, minHeight: '100vh' }}>
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
