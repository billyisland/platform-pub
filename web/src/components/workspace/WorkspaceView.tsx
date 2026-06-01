"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../stores/auth";
import { useWorkspace } from "../../stores/workspace";
import {
  resolveCollisions,
  type VesselRect,
} from "../../lib/workspace/collision";
import { snap } from "../../lib/workspace/grid";
import {
  workspaceFeeds as workspaceFeedsApi,
  type WorkspaceFeed,
  type WorkspaceFeedSource,
  type WorkspaceFeedApiItem,
} from "../../lib/api";
import type {
  FeedItem,
  ExternalFeedItem,
  ReplyGroupItem,
  ArticleEvent,
  NoteEvent,
} from "../../lib/ndk";
import { Vessel } from "./Vessel";
import { VesselCard, NewUserVesselCard, type NewUserItem } from "./VesselCard";
import { PostCard } from "../post/PostCard";
import { PostThread } from "../post/PostThread";
import type { CardContext } from "../post/chassis";
import type { Post } from "../../lib/post/types";
import { mapFeedItemToPost } from "../../lib/post/map-feed-item";
import { usePostCardFlag } from "../../lib/post/flags";
import {
  PALETTES,
  TEXT_SIZE_PX,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
} from "./tokens";
import { ReplyGroupCard } from "./ReplyGroupCard";
import { ForallMenu, type ForallAction } from "./ForallMenu";
import { Composer, type ReplyTarget } from "./Composer";
import { PipPanel } from "./PipPanel";
import { follows as followsApi } from "../../lib/api";
import type { PipStatus } from "../../lib/ndk";
import { NewFeedPrompt } from "./NewFeedPrompt";
import { FeedComposer } from "./FeedComposer";
import { ForallCeremony } from "./ForallCeremony";
import { ReaderPane } from "./ReaderPane";
import { EmptyFeedTile } from "./EmptyFeedTile";
import { MergeFeedConfirm } from "./MergeFeedConfirm";
import { NotificationsAnchor } from "./NotificationsAnchor";
import { SearchAnchor } from "./SearchAnchor";

const FLOOR = "#F0EFEB"; // grey-100 per Step 1 / Colour tokens committed
const DEFAULT_FEED_NAME = "Founder's feed";

// Slice 9: first-login ceremony plays once per user. Storage flag survives
// across logouts on the same browser; the responsive (new-feed) ceremony has
// no equivalent gate since it's a per-action animation, not an onboarding.
const CEREMONY_SEEN_PREFIX = "workspace:ceremony_seen:";

// Ceremony box dimensions (mirrors ForallCeremony's BOX_W / BOX_H — kept
// duplicated locally so the positioning math doesn't need to import the
// component's internals). Referenced only by the commented-out Task 7 entrance
// animation today; retained for the pending re-enable, so silence the
// unused-var lint until then (L3).
/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
const CEREMONY_BOX_W = 300;
/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
const CEREMONY_BOX_H = 300;

interface PendingCeremony {
  feedId: string;
  pace: "ceremonial" | "responsive";
  target: { x: number; y: number };
}

// Slice 5a: vessels are absolutely positioned on the floor and drag-to-move.
// Layout state lives in useWorkspace (localStorage-backed). For any feed
// without a stored position, we compute a default grid slot and write back.

const MIN_H = 200;

const DEFAULT_GRID = {
  paddingX: 40,
  paddingY: 40,
  colWidth: 340, // 300 vessel + 40 gutter
  rowHeight: 600,
};

function defaultGridSlot(
  index: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const usableWidth = Math.max(
    viewportWidth - DEFAULT_GRID.paddingX * 2,
    DEFAULT_GRID.colWidth,
  );
  const cols = Math.max(1, Math.floor(usableWidth / DEFAULT_GRID.colWidth));
  const col = index % cols;
  const row = Math.floor(index / cols);
  const y = DEFAULT_GRID.paddingY + row * DEFAULT_GRID.rowHeight;
  const maxH = snap(
    Math.max(MIN_H, viewportHeight - y - DEFAULT_GRID.paddingY),
  );
  return {
    x: DEFAULT_GRID.paddingX + col * DEFAULT_GRID.colWidth,
    y,
    h: Math.min(DEFAULT_GRID.rowHeight, maxH),
  };
}

type WorkspaceItem = FeedItem | NewUserItem | ReplyGroupItem;

function itemKey(item: WorkspaceItem): string {
  if (item.type === "new_user")
    return `new-user:${item.username}:${item.joinedAt}`;
  if (item.type === "reply_group") return `rg:${item.sourceReplyUri}`;
  return item.id;
}

interface VesselState {
  feed: WorkspaceFeed;
  items: WorkspaceItem[];
  sources: WorkspaceFeedSource[];
  status: "loading" | "ready" | "error";
  caughtUp?: boolean;
}

function mapExternalApiItem(
  item: WorkspaceFeedApiItem & { type: "external" },
): ExternalFeedItem {
  return {
    type: "external",
    id: item.id,
    feedItemId: item.feedItemId,
    externalSourceId: item.externalSourceId,
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
    sourceReplyUri: item.sourceReplyUri ?? null,
    sourceQuoteUri: item.sourceQuoteUri ?? null,
    likeCount: item.likeCount ?? 0,
    replyCount: item.replyCount ?? 0,
    repostCount: item.repostCount ?? 0,
    media: item.media ?? [],
    publishedAt: item.publishedAt,
    sourceName: item.sourceName,
    sourceAvatar: item.sourceAvatar,
    pipStatus: item.pipStatus ?? "unknown",
    savedAt: item.savedAt,
  };
}

function mapApiItem(item: WorkspaceFeedApiItem): WorkspaceItem | null {
  if (item.type === "article") {
    return {
      type: "article",
      id: item.nostrEventId,
      feedItemId: item.feedItemId,
      authorId: item.authorId,
      pubkey: item.pubkey,
      dTag: item.dTag,
      title: item.title,
      summary: item.summary,
      content: item.contentFree ?? "",
      isPaywalled: item.isPaywalled,
      pricePence: item.pricePence,
      gatePositionPct: item.gatePositionPct,
      publishedAt: item.publishedAt,
      tags: [],
      topicTags: item.tags ?? [],
      pipStatus: item.pipStatus,
      sizeTier: item.sizeTier,
      savedAt: item.savedAt,
      media: item.media ?? undefined,
    };
  }
  if (item.type === "note") {
    return {
      type: "note",
      id: item.nostrEventId,
      feedItemId: item.feedItemId,
      authorId: item.authorId,
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
      externalParentId: item.externalParentId,
    };
  }
  if (item.type === "external") {
    return mapExternalApiItem(item);
  }
  if (item.type === "reply_group") {
    return {
      type: "reply_group",
      sourceReplyUri: item.sourceReplyUri,
      publishedAt: item.publishedAt,
      replies: item.replies.map(mapExternalApiItem),
    } as ReplyGroupItem;
  }
  if (item.type === "new_user") {
    return {
      type: "new_user",
      username: item.username,
      displayName: item.displayName ?? null,
      avatar: item.avatar ?? null,
      joinedAt: item.joinedAt,
    };
  }
  return null;
}

export function WorkspaceView() {
  const { user, loading } = useAuth();
  const router = useRouter();
  // UNIVERSAL-POST-ADR Phase 2 — when on, the feed renders the unified PostCard
  // (collapsed feed level) instead of VesselCard; expansion/threads stay legacy.
  const postCardFlag = usePostCardFlag();
  const [vessels, setVessels] = useState<VesselState[]>([]);
  const [bootstrap, setBootstrap] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [composerOpen, setComposerOpen] = useState<false | "note" | "article">(
    false,
  );
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  // Slice 13: which cards have their inline thread expanded, plus a per-target
  // refresh-tick map so an overlay-Composer reply nudges that card's
  // ReplySection to refetch (matching the canonical store).
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(
    new Set(),
  );
  const [threadRefreshTicks, setThreadRefreshTicks] = useState<
    Record<string, number>
  >({});
  const [pipPanel, setPipPanel] = useState<{
    pubkey: string;
    status?: PipStatus;
    rect: DOMRect;
    // Slice 14: which feed the panel was opened from. The volume bar's commit
    // surface scopes per-feed-per-author, so the panel needs to know which
    // ⊔ contributed the click.
    feedId: string;
  } | null>(null);
  const [followedPubkeys, setFollowedPubkeys] = useState<Set<string>>(
    new Set(),
  );
  const [newFeedOpen, setNewFeedOpen] = useState(false);
  const [feedComposerFor, setFeedComposerFor] = useState<WorkspaceFeed | null>(
    null,
  );
  const [ceremony, setCeremony] = useState<PendingCeremony | null>(null);
  const [pendingMerge, setPendingMerge] = useState<{
    source: WorkspaceFeed;
    target: WorkspaceFeed;
  } | null>(null);
  const floorRef = useRef<HTMLDivElement>(null);
  const positions = useWorkspace((s) => s.positions);
  const hydrated = useWorkspace((s) => s.hydrated);
  const hydrate = useWorkspace((s) => s.hydrate);
  const setVesselPosition = useWorkspace((s) => s.setVesselPosition);
  const setVesselSize = useWorkspace((s) => s.setVesselSize);
  const setVesselBrightness = useWorkspace((s) => s.setVesselBrightness);
  const setVesselDensity = useWorkspace((s) => s.setVesselDensity);
  const setVesselOrientation = useWorkspace((s) => s.setVesselOrientation);
  const setVesselTextSize = useWorkspace((s) => s.setVesselTextSize);
  const setVesselHidden = useWorkspace((s) => s.setVesselHidden);
  const removeVesselLayout = useWorkspace((s) => s.removeVessel);
  const batchUpdatePositions = useWorkspace((s) => s.batchUpdatePositions);

  const dragActiveRef = useRef<string | null>(null);

  function handleVesselDragStart(feedId: string) {
    dragActiveRef.current = feedId;
  }

  function handleVesselDragFrame(
    feedId: string,
    pos: { x: number; y: number },
  ) {
    const floor = floorRef.current;
    if (!floor) return;

    const store = useWorkspace.getState();
    const others: VesselRect[] = [];

    floor.querySelectorAll<HTMLElement>("[data-vessel-id]").forEach((el) => {
      const id = el.dataset.vesselId!;
      if (id === feedId) return;
      const layout = store.positions[id];
      if (!layout) return;
      others.push({
        id,
        x: layout.x,
        y: layout.y,
        w: el.offsetWidth,
        h: el.offsetHeight,
      });
    });

    const moverEl = floor.querySelector<HTMLElement>(
      `[data-vessel-id="${feedId}"]`,
    );
    if (!moverEl) return;

    const mover: VesselRect = {
      id: feedId,
      x: pos.x,
      y: pos.y,
      w: moverEl.offsetWidth,
      h: moverEl.offsetHeight,
    };

    const updates = resolveCollisions(mover, others, {
      w: floor.clientWidth,
      h: floor.clientHeight,
    });

    if (updates.size > 0) {
      batchUpdatePositions(Object.fromEntries(updates));
    }
  }

  function handleVesselDragEnd(feedId: string, pos: { x: number; y: number }) {
    setVesselPosition(feedId, pos);
    dragActiveRef.current = null;

    const floor = floorRef.current;
    if (!floor) return;
    const moverEl = floor.querySelector<HTMLElement>(
      `[data-vessel-id="${feedId}"]`,
    );
    if (!moverEl) return;
    const cx = pos.x + moverEl.offsetWidth / 2;
    const cy = pos.y + moverEl.offsetHeight / 2;

    const store = useWorkspace.getState();
    floor.querySelectorAll<HTMLElement>("[data-vessel-id]").forEach((el) => {
      const id = el.dataset.vesselId!;
      if (id === feedId) return;
      const layout = store.positions[id];
      if (!layout || layout.hidden) return;
      if (
        cx >= layout.x &&
        cx <= layout.x + el.offsetWidth &&
        cy >= layout.y &&
        cy <= layout.y + el.offsetHeight
      ) {
        const source = vessels.find((v) => v.feed.id === feedId);
        const target = vessels.find((v) => v.feed.id === id);
        if (source && target) {
          setPendingMerge({ source: source.feed, target: target.feed });
        }
      }
    });
  }

  async function handleMergeConfirm() {
    if (!pendingMerge) return;
    const { source, target } = pendingMerge;
    await workspaceFeedsApi.merge(target.id, source.id);
    setVessels((prev) => {
      const next = prev.filter((v) => v.feed.id !== source.id);
      const targetVessel = next.find((v) => v.feed.id === target.id);
      if (targetVessel) void loadVesselItems(targetVessel.feed);
      return next;
    });
    removeVesselLayout(source.id);
    setPendingMerge(null);
  }

  const loadVesselItems = useCallback(async (feed: WorkspaceFeed) => {
    // A refresh collapses this vessel's conversations: remove every expand key
    // belonging to its current items from both sets. Card expansion keys on
    // `feedItemId ?? id`; thread expansion keys on `id` — so clear both forms.
    const current = vesselsRef.current.find((v) => v.feed.id === feed.id);
    if (current && current.items.length > 0) {
      const keys = new Set<string>();
      for (const it of current.items) {
        if ("id" in it && it.id) keys.add(it.id);
        if ("feedItemId" in it && it.feedItemId) keys.add(it.feedItemId);
      }
      const drop = (prev: Set<string>) => {
        const next = new Set([...prev].filter((k) => !keys.has(k)));
        return next.size === prev.size ? prev : next;
      };
      setExpandedCards(drop);
      setExpandedThreads(drop);
    }

    let prevIds: Set<string> | null = null;
    setVessels((prev) =>
      prev.map((v) => {
        if (v.feed.id !== feed.id) return v;
        if (v.status === "ready" && v.items.length > 0) {
          prevIds = new Set(v.items.map(itemKey));
        }
        return { ...v, status: "loading", caughtUp: false };
      }),
    );
    try {
      const data = await workspaceFeedsApi.items(feed.id);
      const mapped = (data.items ?? [])
        .map(mapApiItem)
        .filter((x: WorkspaceItem | null): x is WorkspaceItem => x !== null);
      const caughtUp =
        prevIds !== null &&
        mapped.length > 0 &&
        mapped.every((i) => (prevIds as Set<string>).has(itemKey(i)));
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feed.id
            ? {
                ...v,
                feed: data.feed,
                items: mapped,
                status: "ready",
                caughtUp,
              }
            : v,
        ),
      );
    } catch (err) {
      console.error("Vessel items load error:", err);
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feed.id ? { ...v, status: "error" } : v,
        ),
      );
    }
  }, []);

  const vesselsRef = useRef(vessels);
  vesselsRef.current = vessels;

  function refreshAll() {
    // Refreshing every vessel collapses every expanded conversation.
    setExpandedCards(new Set());
    setExpandedThreads(new Set());
    vesselsRef.current.forEach((v) => void loadVesselItems(v.feed));
  }

  function handleForallAction(key: ForallAction) {
    if (key === "new-note") {
      setReplyTarget(null);
      setComposerOpen("note");
      return;
    }
    if (key === "new-article") {
      setReplyTarget(null);
      setComposerOpen("article");
      return;
    }
    if (key === "new-feed") {
      setNewFeedOpen(true);
      return;
    }
  }

  function handleRestoreHiddenFeed(feedId: string) {
    setVesselHidden(feedId, false);
  }

  const feedNumerals = new Map<string, number>();
  const sorted = [...vessels].sort(
    (a, b) =>
      new Date(a.feed.createdAt).getTime() -
      new Date(b.feed.createdAt).getTime(),
  );
  sorted.forEach((v, i) => feedNumerals.set(v.feed.id, i + 1));

  function feedDisplayName(feedId: string, feedName: string): string {
    const num = feedNumerals.get(feedId) ?? 1;
    const descriptive = feedName.trim();
    return descriptive ? `Feed ${num}: ${descriptive}` : `Feed ${num}`;
  }

  const hiddenFeeds = vessels
    .filter((v) => positions[v.feed.id]?.hidden)
    .map((v) => ({
      id: v.feed.id,
      name: feedDisplayName(v.feed.id, v.feed.name),
    }));

  function matchItemToSource(
    item: WorkspaceItem,
    sources: WorkspaceFeedSource[],
  ): string | undefined {
    if (item.type === "new_user") return undefined;
    if (item.type === "reply_group") {
      const first = item.replies[0];
      if (!first?.externalSourceId) return undefined;
      return sources.find(
        (s) =>
          s.sourceType === "external_source" &&
          s.externalSourceId === first.externalSourceId,
      )?.id;
    }
    if (item.type === "external") {
      const esId = item.externalSourceId;
      if (!esId) return undefined;
      return sources.find(
        (s) =>
          s.sourceType === "external_source" && s.externalSourceId === esId,
      )?.id;
    }
    const authorId = (item as ArticleEvent | NoteEvent).authorId;
    if (!authorId) return undefined;
    return sources.find(
      (s) => s.sourceType === "account" && s.accountId === authorId,
    )?.id;
  }

  async function handleCardDrop(targetFeedId: string, raw: string) {
    let payload: { feedId: string; feedSourceId: string };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload.feedId === targetFeedId) return;
    try {
      await workspaceFeedsApi.moveSource(
        payload.feedId,
        payload.feedSourceId,
        targetFeedId,
      );
      const src = vessels.find((v) => v.feed.id === payload.feedId);
      const tgt = vessels.find((v) => v.feed.id === targetFeedId);
      if (src) void loadVesselItems(src.feed);
      if (tgt) void loadVesselItems(tgt.feed);
      for (const fid of [payload.feedId, targetFeedId]) {
        workspaceFeedsApi
          .listSources(fid)
          .then(({ sources }) => {
            setVessels((prev) =>
              prev.map((v) => (v.feed.id === fid ? { ...v, sources } : v)),
            );
          })
          .catch(() => {});
      }
    } catch (err) {
      console.error("Move source failed:", err);
    }
  }

  async function handleCreateFeed(name: string) {
    const { feed } = await workspaceFeedsApi.create(name);
    let slot = { x: 0, y: 0, h: DEFAULT_GRID.rowHeight };
    setVessels((prev) => {
      const next = [
        ...prev,
        {
          feed,
          items: [],
          sources: [],
          status: "loading" as const,
        },
      ];
      slot = defaultGridSlot(
        next.length - 1,
        window.innerWidth,
        window.innerHeight,
      );
      setVesselPosition(feed.id, slot);
      setVesselSize(feed.id, { w: 300, h: slot.h });
      return next;
    });
    setNewFeedOpen(false);
    // TODO: re-enable / refine entrance animation
    // setCeremony({ feedId: feed.id, pace: "responsive", target: slot });
    void loadVesselItems(feed);
  }

  useEffect(() => {
    if (!loading && !user) router.push("/auth?mode=login");
  }, [user, loading, router]);

  // Slice 12: fetch the user's followed pubkeys once on mount so the pip
  // panel can render its initial follow state without a per-open round-trip.
  // Failure is non-fatal — panel just defaults to "not following."
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    followsApi
      .listPubkeys()
      .then(({ pubkeys }) => {
        if (cancelled) return;
        setFollowedPubkeys(new Set(pubkeys));
      })
      .catch(() => {
        if (!cancelled) setFollowedPubkeys(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Hydrate the workspace store from localStorage as soon as the user is
  // known. Bootstrap below depends on hydration so default-slot writes don't
  // overwrite a stored layout.
  useEffect(() => {
    if (user) hydrate(user.id);
  }, [user, hydrate]);

  // Bootstrap: list feeds, seed the default if none exist, fetch items per
  // vessel. Re-runs only when the authenticated user changes.
  useEffect(() => {
    if (!user || !hydrated) return;
    let cancelled = false;
    setBootstrap("loading");
    (async () => {
      try {
        let { feeds: list } = await workspaceFeedsApi.list();
        let mintedFounderFeed = false;
        if (list.length === 0) {
          const { feed } = await workspaceFeedsApi.create(DEFAULT_FEED_NAME);
          list = [feed];
          mintedFounderFeed = true;
        }
        if (cancelled) return;
        const initial: VesselState[] = list.map((feed) => ({
          feed,
          items: [],
          sources: [],
          status: "loading",
        }));
        setVessels(initial);
        setBootstrap("ready");

        for (const feed of list) {
          workspaceFeedsApi
            .listSources(feed.id)
            .then(({ sources }) => {
              if (cancelled) return;
              setVessels((prev) =>
                prev.map((v) =>
                  v.feed.id === feed.id ? { ...v, sources } : v,
                ),
              );
            })
            .catch(() => {});
        }

        const stored = useWorkspace.getState().positions;
        const viewportWidth =
          typeof window !== "undefined" ? window.innerWidth : 1280;
        const viewportHeight =
          typeof window !== "undefined" ? window.innerHeight : 800;
        list.forEach((feed, i) => {
          if (!stored[feed.id]) {
            const slot = defaultGridSlot(i, viewportWidth, viewportHeight);
            setVesselPosition(feed.id, slot);
            setVesselSize(feed.id, { w: 300, h: slot.h });
          }
        });

        // First-login ceremony: only if we just minted the default feed AND
        // this user hasn't seen the ceremony before. Plays viewport-centred
        // (per spec: "expands from the centre of an empty screen"). The
        // founder's feed mounts at its grid slot when the ceremony completes;
        // the position discontinuity from centre to slot is a deferred polish.
        const ceremonySeenKey = `${CEREMONY_SEEN_PREFIX}${user.id}`;
        const seen =
          typeof window !== "undefined"
            ? window.localStorage.getItem(ceremonySeenKey) === "true"
            : true;
        if (mintedFounderFeed && !seen && typeof window !== "undefined") {
          // TODO: re-enable / refine entrance animation
          // const cx = window.innerWidth / 2 - CEREMONY_BOX_W / 2;
          // const cy = window.innerHeight / 2 - CEREMONY_BOX_H / 2;
          // setCeremony({
          //   feedId: list[0].id,
          //   pace: "ceremonial",
          //   target: { x: cx, y: cy },
          // });
        }

        for (const feed of list) {
          if (cancelled) return;
          // Fire-and-forget per vessel — no need to serialise.
          void loadVesselItems(feed);
        }
      } catch (err) {
        if (cancelled) return;
        console.error("Workspace bootstrap error:", err);
        setBootstrap("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, hydrated, loadVesselItems, setVesselPosition]);

  if (loading || !user) {
    return <Floor />;
  }

  return (
    <Floor floorRef={floorRef}>
      {bootstrap === "loading" && (
        <CenteredHint>BOOTSTRAPPING WORKSPACE…</CenteredHint>
      )}
      {bootstrap === "error" && (
        <CenteredHint>COULDN&rsquo;T LOAD WORKSPACE</CenteredHint>
      )}
      {bootstrap === "ready" &&
        vessels
          .filter((v) => !positions[v.feed.id]?.hidden)
          .map((v) => {
            const layout = positions[v.feed.id] ?? { x: 0, y: 0 };
            return (
              <Vessel
                key={v.feed.id}
                feedId={v.feed.id}
                numeral={feedNumerals.get(v.feed.id) ?? 1}
                descriptiveName={v.feed.name || undefined}
                onNameClick={() => setFeedComposerFor(v.feed)}
                onSourceAdded={() => {
                  void loadVesselItems(v.feed);
                  workspaceFeedsApi
                    .listSources(v.feed.id)
                    .then(({ sources }) =>
                      setVessels((prev) =>
                        prev.map((vs) =>
                          vs.feed.id === v.feed.id ? { ...vs, sources } : vs,
                        ),
                      ),
                    )
                    .catch(() => {});
                }}
                position={{ x: layout.x, y: layout.y }}
                size={{ w: layout.w, h: layout.h }}
                brightness={layout.brightness}
                density={layout.density}
                orientation={layout.orientation}
                onHide={() => setVesselHidden(v.feed.id, true)}
                onPositionCommit={(next) =>
                  handleVesselDragEnd(v.feed.id, next)
                }
                onSizeCommit={(next) => setVesselSize(v.feed.id, next)}
                onDragStart={() => handleVesselDragStart(v.feed.id)}
                onDragFrame={(pos) => handleVesselDragFrame(v.feed.id, pos)}
                hidden={ceremony?.feedId === v.feed.id}
                dragConstraints={floorRef}
                onCardDrop={(raw) => handleCardDrop(v.feed.id, raw)}
                onRefresh={() => loadVesselItems(v.feed)}
                caughtUp={v.caughtUp}
                onCaughtUpDismiss={() =>
                  setVessels((prev) =>
                    prev.map((vs) =>
                      vs.feed.id === v.feed.id
                        ? { ...vs, caughtUp: false }
                        : vs,
                    ),
                  )
                }
              >
                {v.status === "loading" && <Hint>LOADING…</Hint>}
                {v.status === "error" && <Hint>COULDN&rsquo;T LOAD FEED</Hint>}
                {v.status === "ready" &&
                  v.items.length === 0 &&
                  (v.sources.length === 0 ? (
                    <EmptyFeedTile
                      variant="no-sources"
                      onAddSources={() => setFeedComposerFor(v.feed)}
                    />
                  ) : (
                    <EmptyFeedTile
                      variant="no-items"
                      onAddSources={() => setFeedComposerFor(v.feed)}
                    />
                  ))}
                {v.status === "ready" && v.caughtUp && v.items.length > 0 && (
                  <EmptyFeedTile
                    variant="caught-up"
                    onAddSources={() => setFeedComposerFor(v.feed)}
                    onDismiss={() =>
                      setVessels((prev) =>
                        prev.map((vs) =>
                          vs.feed.id === v.feed.id
                            ? { ...vs, caughtUp: false }
                            : vs,
                        ),
                      )
                    }
                  />
                )}
                {v.status === "ready" &&
                  v.items.slice(0, 12).map((item) =>
                    item.type === "new_user" ? (
                      <NewUserVesselCard
                        key={`new-user-${item.username}-${item.joinedAt}`}
                        item={item}
                        density={layout.density}
                        brightness={layout.brightness}
                      />
                    ) : item.type === "reply_group" ? (
                      <ReplyGroupCard
                        key={`rg-${item.sourceReplyUri}`}
                        group={item}
                        density={layout.density}
                        brightness={layout.brightness}
                        textSize={layout.textSize}
                      />
                    ) : postCardFlag ? (
                      (() => {
                        // UNIVERSAL-POST-ADR Phase 3 — flag-on render. Collapsed
                        // cards are PostCard level="feed"; expanding a note/external
                        // mounts the unified PostThread (ancestors/focal/replies on
                        // the same PostCard). Articles open the reader pane (Phase R),
                        // so they have no inline thread and stay feed cards.
                        const post = mapFeedItemToPost(item);
                        const expandKey =
                          "feedItemId" in item && item.feedItemId
                            ? item.feedItemId
                            : item.id;
                        const isExpanded = expandedCards.has(expandKey);
                        const ctx = {
                          density: layout.density ?? DEFAULT_DENSITY,
                          palette:
                            PALETTES[layout.brightness ?? DEFAULT_BRIGHTNESS],
                          bodyPx:
                            TEXT_SIZE_PX[layout.textSize ?? DEFAULT_TEXT_SIZE],
                          dragData: (() => {
                            const fsId = matchItemToSource(item, v.sources);
                            return fsId
                              ? JSON.stringify({
                                  feedId: v.feed.id,
                                  feedSourceId: fsId,
                                })
                              : undefined;
                          })(),
                        } as CardContext;
                        const toggleExpand = () =>
                          setExpandedCards((prev) => {
                            const next = new Set(prev);
                            if (next.has(expandKey)) next.delete(expandKey);
                            else next.add(expandKey);
                            return next;
                          });
                        const onPipOpen = (
                          pubkey: string,
                          rect: DOMRect,
                          status: typeof post.author.pipStatus | undefined,
                        ) => setPipPanel({ pubkey, rect, status, feedId: v.feed.id });
                        // Native reply only (external interact-back is a Phase 2/3
                        // documented cut). version = the all.haus event id (vote +
                        // reply target); type picks the kind.
                        const replyFromPost = (p: Post) => {
                          setReplyTarget({
                            eventId: p.version ?? p.id,
                            eventKind: p.type === "article" ? 30023 : 1,
                            authorPubkey: p.author.pubkey ?? "",
                            authorName: "",
                            excerpt: (p.body.text ?? "").slice(0, 120),
                          });
                          setComposerOpen("note");
                        };
                        if (isExpanded && post.type !== "article") {
                          return (
                            <PostThread
                              key={item.id}
                              rootPostId={post.id}
                              ctx={ctx}
                              onCollapse={toggleExpand}
                              onReply={replyFromPost}
                              onPipOpen={onPipOpen}
                            />
                          );
                        }
                        return (
                          <PostCard
                            key={item.id}
                            post={post}
                            level="feed"
                            ctx={ctx}
                            onPipOpen={onPipOpen}
                            onExpand={toggleExpand}
                            onReply={
                              post.author.pubkey
                                ? () => replyFromPost(post)
                                : undefined
                            }
                          />
                        );
                      })()
                    ) : (
                      <VesselCard
                        key={item.id}
                        item={item}
                        density={layout.density}
                        brightness={layout.brightness}
                        textSize={layout.textSize}
                        onReply={(target) => {
                          setReplyTarget(target);
                          setComposerOpen("note");
                        }}
                        onPipOpen={(pubkey, rect, status) => {
                          setPipPanel({
                            pubkey,
                            rect,
                            status,
                            feedId: v.feed.id,
                          });
                        }}
                        threadExpanded={expandedThreads.has(item.id)}
                        threadRefreshKey={threadRefreshTicks[item.id]}
                        expanded={expandedCards.has(
                          "feedItemId" in item && item.feedItemId
                            ? item.feedItemId
                            : item.id,
                        )}
                        onToggleExpand={(itemId) => {
                          setExpandedCards((prev) => {
                            const next = new Set(prev);
                            if (next.has(itemId)) next.delete(itemId);
                            else next.add(itemId);
                            return next;
                          });
                        }}
                        dragData={(() => {
                          const fsId = matchItemToSource(item, v.sources);
                          if (!fsId) return undefined;
                          return JSON.stringify({
                            feedId: v.feed.id,
                            feedSourceId: fsId,
                          });
                        })()}
                      />
                    ),
                  )}
              </Vessel>
            );
          })}
      <ForallMenu
        onAction={handleForallAction}
        hiddenFeeds={hiddenFeeds}
        onRestore={handleRestoreHiddenFeed}
      />
      <NotificationsAnchor />
      <SearchAnchor />
      <Composer
        open={!!composerOpen}
        initialMode={composerOpen === "article" ? "article" : "note"}
        replyTarget={replyTarget}
        onClose={() => {
          setComposerOpen(false);
          setReplyTarget(null);
        }}
        onPublished={refreshAll}
        onReplied={(targetEventId) => {
          // Bump the per-target tick so any expanded inline thread refetches.
          // Also auto-expand so a reply published from the overlay is visible
          // without a second click.
          setThreadRefreshTicks((prev) => ({
            ...prev,
            [targetEventId]: (prev[targetEventId] ?? 0) + 1,
          }));
          setExpandedThreads((prev) => {
            const next = new Set(prev);
            next.add(targetEventId);
            return next;
          });
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
        deleteBlocked={
          vessels.filter((v) => !positions[v.feed.id]?.hidden).length <= 1
        }
        brightness={
          feedComposerFor ? positions[feedComposerFor.id]?.brightness : undefined
        }
        density={
          feedComposerFor ? positions[feedComposerFor.id]?.density : undefined
        }
        orientation={
          feedComposerFor
            ? positions[feedComposerFor.id]?.orientation
            : undefined
        }
        textSize={
          feedComposerFor ? positions[feedComposerFor.id]?.textSize : undefined
        }
        onBrightnessChange={(next) =>
          feedComposerFor && setVesselBrightness(feedComposerFor.id, next)
        }
        onDensityChange={(next) =>
          feedComposerFor && setVesselDensity(feedComposerFor.id, next)
        }
        onOrientationChange={(next) =>
          feedComposerFor && setVesselOrientation(feedComposerFor.id, next)
        }
        onTextSizeChange={(next) =>
          feedComposerFor && setVesselTextSize(feedComposerFor.id, next)
        }
        onClose={() => setFeedComposerFor(null)}
        onSourcesChanged={() => {
          if (!feedComposerFor) return;
          void loadVesselItems(feedComposerFor);
          workspaceFeedsApi
            .listSources(feedComposerFor.id)
            .then(({ sources }) =>
              setVessels((prev) =>
                prev.map((v) =>
                  v.feed.id === feedComposerFor.id ? { ...v, sources } : v,
                ),
              ),
            )
            .catch(() => {});
        }}
        onRenamed={(updated) => {
          setVessels((prev) =>
            prev.map((v) =>
              v.feed.id === updated.id ? { ...v, feed: updated } : v,
            ),
          );
          setFeedComposerFor((curr) =>
            curr && curr.id === updated.id ? updated : curr,
          );
        }}
        onDeleted={(feedId) => {
          setVessels((prev) => prev.filter((v) => v.feed.id !== feedId));
          removeVesselLayout(feedId);
          setFeedComposerFor(null);
        }}
      />
      <MergeFeedConfirm
        open={!!pendingMerge}
        sourceName={
          pendingMerge
            ? feedDisplayName(pendingMerge.source.id, pendingMerge.source.name)
            : ""
        }
        targetName={
          pendingMerge
            ? feedDisplayName(pendingMerge.target.id, pendingMerge.target.name)
            : ""
        }
        onClose={() => setPendingMerge(null)}
        onConfirm={handleMergeConfirm}
      />
      <PipPanel
        open={!!pipPanel}
        pubkey={pipPanel?.pubkey ?? ""}
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
            const next = new Set(prev);
            if (isFollowing) next.add(pk);
            else next.delete(pk);
            return next;
          });
        }}
        onVolumeChanged={(feedId) => {
          // Mute state is honoured by the items query (slice 4); refetch the
          // affected vessel so a freshly-muted author drops from the visible
          // set without a manual reload.
          const target = vessels.find((v) => v.feed.id === feedId);
          if (target) void loadVesselItems(target.feed);
        }}
      />
      {ceremony && (
        <ForallCeremony
          key={ceremony.feedId}
          pace={ceremony.pace}
          target={ceremony.target}
          onComplete={() => {
            if (
              ceremony.pace === "ceremonial" &&
              user &&
              typeof window !== "undefined"
            ) {
              try {
                window.localStorage.setItem(
                  `${CEREMONY_SEEN_PREFIX}${user.id}`,
                  "true",
                );
              } catch {
                // Quota / private browsing — fall through; worst case is the
                // ceremony plays again on next first-feed mint, which is rare.
              }
            }
            setCeremony(null);
          }}
        />
      )}
      <ReaderPane />
    </Floor>
  );
}

function Floor({
  children,
  floorRef,
}: {
  children?: React.ReactNode;
  floorRef?: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={floorRef}
      style={{
        background: FLOOR,
        minHeight: "100vh",
        height: "100vh",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

function CenteredHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="label-ui text-center"
      style={{
        color: "#9C9A94",
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      }}
    >
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="label-ui py-6 text-center" style={{ color: "#9C9A94" }}>
      {children}
    </div>
  );
}
