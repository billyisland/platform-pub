'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { useWorkspace } from '../../stores/workspace'
import { workspaceFeeds as workspaceFeedsApi, type WorkspaceFeed } from '../../lib/api'
import type { FeedItem, ExternalFeedItem } from '../../lib/ndk'
import { Vessel } from './Vessel'
import { VesselCard, NewUserVesselCard } from './VesselCard'
import { ForallMenu, type ForallAction } from './ForallMenu'
import { Composer } from './Composer'
import { NewFeedPrompt } from './NewFeedPrompt'
import { FeedComposer } from './FeedComposer'
import { ResetLayoutConfirm } from './ResetLayoutConfirm'
import { ForkFeedPrompt } from './ForkFeedPrompt'

const FLOOR = '#F0EFEB' // grey-100 per Step 1 / Colour tokens committed
const DEFAULT_FEED_NAME = "Founder's feed"

// Slice 5a: vessels are absolutely positioned on the floor and drag-to-move.
// Layout state lives in useWorkspace (localStorage-backed). For any feed
// without a stored position, we compute a default grid slot and write back.

// Default-grid geometry. Vessels are 300px wide; we leave a 40px gutter on
// the right so name labels don't crowd. Row height is approximate — vessels
// vary, but the grid only matters until the user drags. Top padding leaves
// room for browser UI / future header elements.
const DEFAULT_GRID = {
  paddingX: 32,
  paddingY: 32,
  colWidth: 340, // 300 vessel + 40 gutter
  rowHeight: 600,
}

function defaultGridSlot(index: number, viewportWidth: number) {
  const usableWidth = Math.max(viewportWidth - DEFAULT_GRID.paddingX * 2, DEFAULT_GRID.colWidth)
  const cols = Math.max(1, Math.floor(usableWidth / DEFAULT_GRID.colWidth))
  const col = index % cols
  const row = Math.floor(index / cols)
  return {
    x: DEFAULT_GRID.paddingX + col * DEFAULT_GRID.colWidth,
    y: DEFAULT_GRID.paddingY + row * DEFAULT_GRID.rowHeight,
  }
}

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
  const [feedComposerFor, setFeedComposerFor] = useState<WorkspaceFeed | null>(null)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [forkOpen, setForkOpen] = useState(false)
  const floorRef = useRef<HTMLDivElement>(null)
  const positions = useWorkspace((s) => s.positions)
  const hydrated = useWorkspace((s) => s.hydrated)
  const hydrate = useWorkspace((s) => s.hydrate)
  const setVesselPosition = useWorkspace((s) => s.setVesselPosition)
  const setVesselSize = useWorkspace((s) => s.setVesselSize)
  const setVesselBrightness = useWorkspace((s) => s.setVesselBrightness)
  const setVesselDensity = useWorkspace((s) => s.setVesselDensity)
  const setVesselOrientation = useWorkspace((s) => s.setVesselOrientation)
  const removeVesselLayout = useWorkspace((s) => s.removeVessel)
  const resetWorkspace = useWorkspace((s) => s.reset)

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
    if (key === 'reset') {
      setResetConfirmOpen(true)
      return
    }
    if (key === 'fork') {
      setForkOpen(true)
      return
    }
    console.log(`[workspace] ${key} — not yet wired`)
  }

  function handleForked(feed: WorkspaceFeed) {
    setVessels((prev) => {
      const next = [...prev, { feed, items: [], status: 'loading' as const }]
      const slot = defaultGridSlot(next.length - 1, window.innerWidth)
      setVesselPosition(feed.id, slot)
      return next
    })
    setForkOpen(false)
    void loadVesselItems(feed)
  }

  function handleResetLayout() {
    // Wipe stored layout, then re-seed default grid slots for the current
    // vessels in their existing order so the floor doesn't briefly collapse
    // to (0, 0) before the next paint.
    resetWorkspace()
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
    vessels.forEach((v, i) => {
      setVesselPosition(v.feed.id, defaultGridSlot(i, viewportWidth))
    })
    setResetConfirmOpen(false)
  }

  async function handleCreateFeed(name: string) {
    const { feed } = await workspaceFeedsApi.create(name)
    setVessels((prev) => {
      const next = [...prev, { feed, items: [], status: 'loading' as const }]
      // Default position for the newly-added vessel: next slot in the grid.
      const slot = defaultGridSlot(next.length - 1, window.innerWidth)
      setVesselPosition(feed.id, slot)
      return next
    })
    setNewFeedOpen(false)
    void loadVesselItems(feed)
  }

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  // Hydrate the workspace store from localStorage as soon as the user is
  // known. Bootstrap below depends on hydration so default-slot writes don't
  // overwrite a stored layout.
  useEffect(() => {
    if (user) hydrate(user.id)
  }, [user, hydrate])

  // Bootstrap: list feeds, seed the default if none exist, fetch items per
  // vessel. Re-runs only when the authenticated user changes.
  useEffect(() => {
    if (!user || !hydrated) return
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

        // Assign default positions for any feed without a stored layout.
        // Reads the live store inside getState() to avoid stale-closure issues.
        const stored = useWorkspace.getState().positions
        const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
        list.forEach((feed, i) => {
          if (!stored[feed.id]) {
            setVesselPosition(feed.id, defaultGridSlot(i, viewportWidth))
          }
        })

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
  }, [user, hydrated, loadVesselItems, setVesselPosition])

  if (loading || !user) {
    return <Floor />
  }

  return (
    <Floor floorRef={floorRef}>
      {bootstrap === 'loading' && <CenteredHint>BOOTSTRAPPING WORKSPACE…</CenteredHint>}
      {bootstrap === 'error' && <CenteredHint>COULDN&rsquo;T LOAD WORKSPACE</CenteredHint>}
      {bootstrap === 'ready' &&
        vessels.map((v) => {
          const layout = positions[v.feed.id] ?? { x: 0, y: 0 }
          return (
            <Vessel
              key={v.feed.id}
              name={v.feed.name}
              onNameClick={() => setFeedComposerFor(v.feed)}
              position={{ x: layout.x, y: layout.y }}
              size={{ w: layout.w, h: layout.h }}
              brightness={layout.brightness}
              density={layout.density}
              orientation={layout.orientation}
              onPositionCommit={(next) => setVesselPosition(v.feed.id, next)}
              onSizeCommit={(next) => setVesselSize(v.feed.id, next)}
              onBrightnessCommit={(next) => setVesselBrightness(v.feed.id, next)}
              onDensityCommit={(next) => setVesselDensity(v.feed.id, next)}
              onOrientationCommit={(next) => setVesselOrientation(v.feed.id, next)}
              dragConstraints={floorRef}
            >
              {v.status === 'loading' && <Hint>LOADING…</Hint>}
              {v.status === 'error' && <Hint>COULDN&rsquo;T LOAD FEED</Hint>}
              {v.status === 'ready' && v.items.length === 0 && <Hint>NO ITEMS</Hint>}
              {v.status === 'ready' &&
                v.items.slice(0, 12).map((item) =>
                  item.type === 'new_user' ? (
                    <NewUserVesselCard
                      key={`new-user-${item.username}-${item.joinedAt}`}
                      item={item}
                      density={layout.density}
                      brightness={layout.brightness}
                    />
                  ) : (
                    <VesselCard
                      key={item.id}
                      item={item}
                      density={layout.density}
                      brightness={layout.brightness}
                    />
                  ),
                )}
            </Vessel>
          )
        })}
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
      <FeedComposer
        open={!!feedComposerFor}
        feed={feedComposerFor}
        deleteBlocked={vessels.length <= 1}
        onClose={() => setFeedComposerFor(null)}
        onSourcesChanged={() => {
          if (feedComposerFor) void loadVesselItems(feedComposerFor)
        }}
        onRenamed={(updated) => {
          setVessels((prev) =>
            prev.map((v) => (v.feed.id === updated.id ? { ...v, feed: updated } : v)),
          )
          setFeedComposerFor((curr) => (curr && curr.id === updated.id ? updated : curr))
        }}
        onDeleted={(feedId) => {
          setVessels((prev) => prev.filter((v) => v.feed.id !== feedId))
          removeVesselLayout(feedId)
          setFeedComposerFor(null)
        }}
      />
      <ResetLayoutConfirm
        open={resetConfirmOpen}
        vesselCount={vessels.length}
        onClose={() => setResetConfirmOpen(false)}
        onConfirm={handleResetLayout}
      />
      <ForkFeedPrompt
        open={forkOpen}
        onClose={() => setForkOpen(false)}
        onForked={handleForked}
      />
    </Floor>
  )
}

function Floor({
  children,
  floorRef,
}: {
  children?: React.ReactNode
  floorRef?: React.RefObject<HTMLDivElement>
}) {
  return (
    <div
      ref={floorRef}
      style={{
        background: FLOOR,
        minHeight: '100vh',
        height: '100vh',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  )
}

function CenteredHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono text-[11px] uppercase tracking-[0.06em] text-center"
      style={{
        color: '#9C9A94',
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
      }}
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
