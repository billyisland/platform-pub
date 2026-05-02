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
import { Composer, type ReplyTarget } from './Composer'
import { PipPanel } from './PipPanel'
import { follows as followsApi } from '../../lib/api'
import type { PipStatus } from '../../lib/ndk'
import { NewFeedPrompt } from './NewFeedPrompt'
import { FeedComposer } from './FeedComposer'
import { ResetLayoutConfirm } from './ResetLayoutConfirm'
import { ForkFeedPrompt } from './ForkFeedPrompt'
import { ForallCeremony } from './ForallCeremony'

const FLOOR = '#F0EFEB' // grey-100 per Step 1 / Colour tokens committed
const DEFAULT_FEED_NAME = "Founder's feed"

// Slice 9: first-login ceremony plays once per user. Storage flag survives
// across logouts on the same browser; the responsive (new-feed) ceremony has
// no equivalent gate since it's a per-action animation, not an onboarding.
const CEREMONY_SEEN_PREFIX = 'workspace:ceremony_seen:'

// Ceremony box dimensions (mirrors ForallCeremony's BOX_W / BOX_H — kept
// duplicated locally so positioning math doesn't need to import the
// component's internals).
const CEREMONY_BOX_W = 300
const CEREMONY_BOX_H = 300

interface PendingCeremony {
  feedId: string
  pace: 'ceremonial' | 'responsive'
  target: { x: number; y: number }
}

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
  // Slice 20: per-vessel view-mode + savedIds Set. View defaults to 'live'
  // on each new vessel; the toggle never persists across reloads (ADR §3
  // saved-state persistence is server-backed, view-mode-toggle is session
  // ephemeral so the workspace re-opens "live" — saved view is a brief
  // detour, not a sticky channel).
  view: 'live' | 'saved'
  savedIds: Set<string>
}

function mapApiItem(item: any): WorkspaceItem | null {
  if (item.type === 'article') {
    return {
      type: 'article',
      id: item.nostrEventId,
      feedItemId: item.feedItemId,
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
      savedAt: item.savedAt,
    }
  }
  if (item.type === 'note') {
    return {
      type: 'note',
      id: item.nostrEventId,
      feedItemId: item.feedItemId,
      pubkey: item.pubkey,
      content: item.content,
      publishedAt: item.publishedAt,
      quotedEventId: item.quotedEventId,
      quotedEventKind: item.quotedEventKind,
      quotedExcerpt: item.quotedExcerpt,
      quotedTitle: item.quotedTitle,
      quotedAuthor: item.quotedAuthor,
      pipStatus: item.pipStatus,
      savedAt: item.savedAt,
    }
  }
  if (item.type === 'external') {
    return {
      type: 'external',
      id: item.id,
      feedItemId: item.feedItemId,
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
      savedAt: item.savedAt,
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
  const [composerOpen, setComposerOpen] = useState<false | 'note' | 'article'>(false)
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null)
  // Slice 13: which cards have their inline thread expanded, plus a per-target
  // refresh-tick map so an overlay-Composer reply nudges that card's
  // ReplySection to refetch (matching the canonical store).
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set())
  const [threadRefreshTicks, setThreadRefreshTicks] = useState<Record<string, number>>({})
  const [pipPanel, setPipPanel] = useState<{
    pubkey: string
    status?: PipStatus
    rect: DOMRect
    // Slice 14: which feed the panel was opened from. The volume bar's commit
    // surface scopes per-feed-per-author, so the panel needs to know which
    // ⊔ contributed the click.
    feedId: string
  } | null>(null)
  const [followedPubkeys, setFollowedPubkeys] = useState<Set<string>>(new Set())
  const [newFeedOpen, setNewFeedOpen] = useState(false)
  const [feedComposerFor, setFeedComposerFor] = useState<WorkspaceFeed | null>(null)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [forkOpen, setForkOpen] = useState(false)
  const [ceremony, setCeremony] = useState<PendingCeremony | null>(null)
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

  // Slice 20: load function honours the vessel's current view mode. The
  // saved view returns the same item shapes from a different endpoint, so
  // the rest of the rendering pipeline doesn't branch.
  const loadVesselItems = useCallback(async (feed: WorkspaceFeed, view?: 'live' | 'saved') => {
    setVessels((prev) =>
      prev.map((v) => (v.feed.id === feed.id ? { ...v, status: 'loading' } : v)),
    )
    try {
      const effView =
        view ?? vesselViewRef.current.get(feed.id) ?? 'live'
      const data =
        effView === 'saved'
          ? await workspaceFeedsApi.listSaves(feed.id)
          : await workspaceFeedsApi.items(feed.id)
      const mapped = (data.items ?? [])
        .map(mapApiItem)
        .filter((x: WorkspaceItem | null): x is WorkspaceItem => x !== null)
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feed.id ? { ...v, feed: data.feed, items: mapped, status: 'ready' } : v,
        ),
      )
    } catch (err) {
      console.error('Vessel items load error:', err)
      setVessels((prev) =>
        prev.map((v) => (v.feed.id === feed.id ? { ...v, status: 'error' } : v)),
      )
    }
  }, [])

  // Mirror the vessels' current view modes into a ref so loadVesselItems can
  // read the right view without taking a fresh closure on every state change.
  const vesselViewRef = useRef<Map<string, 'live' | 'saved'>>(new Map())
  useEffect(() => {
    const next = new Map<string, 'live' | 'saved'>()
    vessels.forEach((v) => next.set(v.feed.id, v.view))
    vesselViewRef.current = next
  }, [vessels])

  function refreshAll() {
    vessels.forEach((v) => void loadVesselItems(v.feed))
  }

  // Slice 20: optimistic save toggle. The savedIds Set on each vessel drives
  // the strip's Save / Saved label; we mutate it before the request and
  // revert on failure. While in saved view, an unsave additionally drops the
  // item from the visible list so the gesture's outcome is observable
  // without a refetch.
  const handleToggleSave = useCallback(
    async (feedId: string, feedItemId: string, next: boolean) => {
      setVessels((prev) =>
        prev.map((v) => {
          if (v.feed.id !== feedId) return v
          const ids = new Set(v.savedIds)
          if (next) ids.add(feedItemId)
          else ids.delete(feedItemId)
          const items =
            v.view === 'saved' && !next
              ? v.items.filter((it) =>
                  'feedItemId' in it ? it.feedItemId !== feedItemId : true,
                )
              : v.items
          return { ...v, savedIds: ids, items }
        }),
      )
      try {
        if (next) {
          await workspaceFeedsApi.saveItem(feedId, feedItemId)
        } else {
          await workspaceFeedsApi.unsaveItem(feedId, feedItemId)
        }
      } catch (err) {
        console.error('Save toggle failed:', err)
        // Roll back the optimistic flip on failure. We don't restore a
        // dropped item to the saved view since we don't keep its data after
        // the filter above; the user can flip back to live and retry.
        setVessels((prev) =>
          prev.map((v) => {
            if (v.feed.id !== feedId) return v
            const ids = new Set(v.savedIds)
            if (next) ids.delete(feedItemId)
            else ids.add(feedItemId)
            return { ...v, savedIds: ids }
          }),
        )
      }
    },
    [],
  )

  function handleToggleSavedView(feedId: string) {
    let nextView: 'live' | 'saved' = 'live'
    let target: WorkspaceFeed | null = null
    setVessels((prev) =>
      prev.map((v) => {
        if (v.feed.id !== feedId) return v
        nextView = v.view === 'live' ? 'saved' : 'live'
        target = v.feed
        return { ...v, view: nextView, items: [], status: 'loading' }
      }),
    )
    if (target) void loadVesselItems(target, nextView)
  }

  function handleForallAction(key: ForallAction) {
    if (key === 'new-note') {
      setReplyTarget(null)
      setComposerOpen('note')
      return
    }
    if (key === 'new-article') {
      setReplyTarget(null)
      setComposerOpen('article')
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
    let slot = { x: 0, y: 0 }
    setVessels((prev) => {
      const next = [
        ...prev,
        {
          feed,
          items: [],
          status: 'loading' as const,
          view: 'live' as const,
          savedIds: new Set<string>(),
        },
      ]
      slot = defaultGridSlot(next.length - 1, window.innerWidth)
      setVesselPosition(feed.id, slot)
      return next
    })
    setForkOpen(false)
    setCeremony({ feedId: feed.id, pace: 'responsive', target: slot })
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
    let slot = { x: 0, y: 0 }
    setVessels((prev) => {
      const next = [
        ...prev,
        {
          feed,
          items: [],
          status: 'loading' as const,
          view: 'live' as const,
          savedIds: new Set<string>(),
        },
      ]
      // Default position for the newly-added vessel: next slot in the grid.
      slot = defaultGridSlot(next.length - 1, window.innerWidth)
      setVesselPosition(feed.id, slot)
      return next
    })
    setNewFeedOpen(false)
    setCeremony({ feedId: feed.id, pace: 'responsive', target: slot })
    void loadVesselItems(feed)
  }

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  // Slice 12: fetch the user's followed pubkeys once on mount so the pip
  // panel can render its initial follow state without a per-open round-trip.
  // Failure is non-fatal — panel just defaults to "not following."
  useEffect(() => {
    if (!user) return
    let cancelled = false
    followsApi
      .listPubkeys()
      .then(({ pubkeys }) => {
        if (cancelled) return
        setFollowedPubkeys(new Set(pubkeys))
      })
      .catch(() => {
        if (!cancelled) setFollowedPubkeys(new Set())
      })
    return () => {
      cancelled = true
    }
  }, [user])

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
        let mintedFounderFeed = false
        if (list.length === 0) {
          const { feed } = await workspaceFeedsApi.create(DEFAULT_FEED_NAME)
          list = [feed]
          mintedFounderFeed = true
        }
        if (cancelled) return
        const initial: VesselState[] = list.map((feed) => ({
          feed,
          items: [],
          status: 'loading',
          view: 'live',
          savedIds: new Set<string>(),
        }))
        setVessels(initial)
        setBootstrap('ready')

        // Slice 20: prefetch saved-id sets per feed so the Save / Saved
        // labels on the strip render correctly from first paint. Failures
        // are non-fatal — the strip just defaults to "Save" until the user
        // commits a change.
        for (const feed of list) {
          workspaceFeedsApi
            .listSavedIds(feed.id)
            .then(({ feedItemIds }) => {
              if (cancelled) return
              setVessels((prev) =>
                prev.map((v) =>
                  v.feed.id === feed.id
                    ? { ...v, savedIds: new Set(feedItemIds) }
                    : v,
                ),
              )
            })
            .catch(() => {})
        }

        // Assign default positions for any feed without a stored layout.
        // Reads the live store inside getState() to avoid stale-closure issues.
        const stored = useWorkspace.getState().positions
        const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
        list.forEach((feed, i) => {
          if (!stored[feed.id]) {
            setVesselPosition(feed.id, defaultGridSlot(i, viewportWidth))
          }
        })

        // First-login ceremony: only if we just minted the default feed AND
        // this user hasn't seen the ceremony before. Plays viewport-centred
        // (per spec: "expands from the centre of an empty screen"). The
        // founder's feed mounts at its grid slot when the ceremony completes;
        // the position discontinuity from centre to slot is a deferred polish.
        const ceremonySeenKey = `${CEREMONY_SEEN_PREFIX}${user.id}`
        const seen =
          typeof window !== 'undefined'
            ? window.localStorage.getItem(ceremonySeenKey) === 'true'
            : true
        if (mintedFounderFeed && !seen && typeof window !== 'undefined') {
          const cx = window.innerWidth / 2 - CEREMONY_BOX_W / 2
          const cy = window.innerHeight / 2 - CEREMONY_BOX_H / 2
          setCeremony({
            feedId: list[0].id,
            pace: 'ceremonial',
            target: { x: cx, y: cy },
          })
        }

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
              savedView={v.view === 'saved'}
              onToggleSavedView={() => handleToggleSavedView(v.feed.id)}
              onPositionCommit={(next) => setVesselPosition(v.feed.id, next)}
              onSizeCommit={(next) => setVesselSize(v.feed.id, next)}
              onBrightnessCommit={(next) => setVesselBrightness(v.feed.id, next)}
              onDensityCommit={(next) => setVesselDensity(v.feed.id, next)}
              onOrientationCommit={(next) => setVesselOrientation(v.feed.id, next)}
              hidden={ceremony?.feedId === v.feed.id}
              dragConstraints={floorRef}
            >
              {v.status === 'loading' && <Hint>LOADING…</Hint>}
              {v.status === 'error' && <Hint>COULDN&rsquo;T LOAD FEED</Hint>}
              {v.status === 'ready' && v.items.length === 0 && (
                <Hint>
                  {v.view === 'saved'
                    ? 'NO SAVED ITEMS YET — TAP SAVE ON A CARD TO KEEP IT HERE'
                    : 'NO ITEMS'}
                </Hint>
              )}
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
                      onReply={(target) => {
                        setReplyTarget(target)
                        setComposerOpen('note')
                      }}
                      onPipOpen={(pubkey, rect, status) => {
                        setPipPanel({ pubkey, rect, status, feedId: v.feed.id })
                      }}
                      threadExpanded={expandedThreads.has(item.id)}
                      onToggleThread={(target) => {
                        setExpandedThreads((prev) => {
                          const next = new Set(prev)
                          if (next.has(target.eventId)) next.delete(target.eventId)
                          else next.add(target.eventId)
                          return next
                        })
                      }}
                      threadRefreshKey={threadRefreshTicks[item.id]}
                      isSaved={
                        'feedItemId' in item && item.feedItemId
                          ? v.savedIds.has(item.feedItemId)
                          : false
                      }
                      onToggleSave={(feedItemId, next) =>
                        void handleToggleSave(v.feed.id, feedItemId, next)
                      }
                    />
                  ),
                )}
            </Vessel>
          )
        })}
      <ForallMenu onAction={handleForallAction} />
      <Composer
        open={!!composerOpen}
        initialMode={composerOpen === 'article' ? 'article' : 'note'}
        replyTarget={replyTarget}
        onClose={() => {
          setComposerOpen(false)
          setReplyTarget(null)
        }}
        onPublished={refreshAll}
        onReplied={(targetEventId) => {
          // Bump the per-target tick so any expanded inline thread refetches.
          // Also auto-expand so a reply published from the overlay is visible
          // without a second click.
          setThreadRefreshTicks((prev) => ({
            ...prev,
            [targetEventId]: (prev[targetEventId] ?? 0) + 1,
          }))
          setExpandedThreads((prev) => {
            const next = new Set(prev)
            next.add(targetEventId)
            return next
          })
        }}
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
      <PipPanel
        open={!!pipPanel}
        pubkey={pipPanel?.pubkey ?? ''}
        pipStatus={pipPanel?.status}
        feedId={pipPanel?.feedId}
        anchorRect={
          pipPanel
            ? {
                top: pipPanel.rect.top,
                left: pipPanel.rect.left,
                bottom: pipPanel.rect.bottom,
                right: pipPanel.rect.right,
              }
            : null
        }
        initialIsFollowing={
          pipPanel ? followedPubkeys.has(pipPanel.pubkey) : false
        }
        onClose={() => setPipPanel(null)}
        onFollowChanged={(pk, isFollowing) => {
          setFollowedPubkeys((prev) => {
            const next = new Set(prev)
            if (isFollowing) next.add(pk)
            else next.delete(pk)
            return next
          })
        }}
        onVolumeChanged={(feedId) => {
          // Mute state is honoured by the items query (slice 4); refetch the
          // affected vessel so a freshly-muted author drops from the visible
          // set without a manual reload.
          const target = vessels.find((v) => v.feed.id === feedId)
          if (target) void loadVesselItems(target.feed)
        }}
      />
      {ceremony && (
        <ForallCeremony
          key={ceremony.feedId}
          pace={ceremony.pace}
          target={ceremony.target}
          onComplete={() => {
            if (ceremony.pace === 'ceremonial' && user && typeof window !== 'undefined') {
              try {
                window.localStorage.setItem(`${CEREMONY_SEEN_PREFIX}${user.id}`, 'true')
              } catch {
                // Quota / private browsing — fall through; worst case is the
                // ceremony plays again on next first-feed mint, which is rare.
              }
            }
            setCeremony(null)
          }}
        />
      )}
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
