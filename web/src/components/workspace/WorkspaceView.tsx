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
  follows as followsApi,
  type WorkspaceFeed,
  type WorkspaceFeedSource,
} from "../../lib/api";
import type { PipStatus } from "../../lib/ndk";
import { Vessel } from "./Vessel";
import { PostCardInteractive } from "../post/PostCardInteractive";
import { PostThread } from "../post/PostThread";
import type { CardContext } from "../post/chassis";
import type { Post } from "../../lib/post/types";
import { originWebUrl } from "../../lib/post/origin-url";
import {
  paletteFor,
  normalizeBrightness,
  TEXT_SIZE_PX,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
} from "./tokens";
import { ForallMenu, type ForallAction } from "./ForallMenu";
import { Composer, type ReplyTarget } from "./Composer";
import type { QuoteTarget } from "../../lib/publishNote";
import { getCachedWriterName, resolveWriterName } from "../../hooks/useWriterName";
import { PipPanel } from "./PipPanel";
import { NewFeedPrompt } from "./NewFeedPrompt";
import { FeedComposer } from "./FeedComposer";
import { ForallCeremony } from "./ForallCeremony";
// Overlays are code-split + open-gated in LazyOverlays (performance audit #4):
// their chunks (incl. TipTap/Stripe via the editor/ledger) leave the /reader
// bundle and load on first open.
import {
  LazyReaderOverlay as ReaderOverlay,
  LazyMessagesOverlay as MessagesOverlay,
  LazyDashboardOverlay as DashboardOverlay,
  LazyLedgerOverlay as LedgerOverlay,
  LazySettingsOverlay as SettingsOverlay,
  LazyLibraryOverlay as LibraryOverlay,
  LazyNetworkOverlay as NetworkOverlay,
} from "./LazyOverlays";
import { useReader } from "../../stores/reader";
import { useCompose } from "../../stores/compose";
import { useEditorOverlay } from "../../stores/editorOverlay";
import {
  openOverlayFromParams,
  OVERLAY_PARAM_KEYS,
} from "../../lib/workspace/overlays";
import { EmptyFeedTile } from "./EmptyFeedTile";
import { MergeFeedConfirm } from "./MergeFeedConfirm";
import { MobileWorkspace } from "./MobileWorkspace";
import { useIsMobile } from "../../hooks/useIsMobile";

const FLOOR = "var(--ah-bone)"; // grey-100 per Step 1 / Colour tokens committed
const DEFAULT_FEED_NAME = "Founder's feed";

// Friendly origin label shown on the quoted-mini when quoting an external post
// (mirrors PostOriginTag / SourceAttribution). Falls back to the source name,
// then the upper-cased protocol.
const EXTERNAL_QUOTE_LABEL: Record<string, string> = {
  atproto: "BLUESKY",
  activitypub: "FEDIVERSE",
  nostr_external: "NOSTR",
  rss: "RSS",
  email: "EMAIL",
};

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

// The workspace items endpoint now emits the unified Post[] directly (gateway
// feedItemToPost) — no client-side legacy-item adapter (FEED-RETIREMENT-PLAN
// Slice 6 item 4). Dedup/resume key off the deterministic post_id.
function itemKey(item: Post): string {
  return item.id;
}

interface VesselState {
  feed: WorkspaceFeed;
  items: Post[];
  sources: WorkspaceFeedSource[];
  status: "loading" | "ready" | "error";
  caughtUp?: boolean;
  // Infinite scroll: cursor for the next (older) page — null once exhausted,
  // undefined before the first load. `loadingMore` gates concurrent fetches.
  nextCursor?: string | null;
  loadingMore?: boolean;
}


export function WorkspaceView() {
  const { user, loading } = useAuth();
  const router = useRouter();
  // MOBILE-LAYOUT-ADR: mobile is not a reflow of the canvas — it is a
  // different interaction model over the same feeds. This switch swaps the
  // body (vessels ↔ pager) while everything else (data, overlays, composer,
  // pip panel) is shared.
  const isMobile = useIsMobile();
  const [vessels, setVessels] = useState<VesselState[]>([]);
  const [bootstrap, setBootstrap] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [composerOpen, setComposerOpen] = useState<false | "note">(false);
  // Live mirror for the attach-once ⌘K handler below.
  const composerOpenRef = useRef<false | "note">(false);
  composerOpenRef.current = composerOpen;
  // Monotonic sequence for overlapping reorder PUTs (see handleReorderFeeds).
  const reorderSeqRef = useRef(0);
  // Bridge the global compose store into the workspace's local Composer. The
  // global ComposeOverlay is not mounted in the chromeless workspace, so any
  // in-workspace surface that lives outside this component requests a note
  // compose by calling useCompose.open('note'); we mirror that into local state
  // here. (Article writing is the global EditorOverlay, opened directly.)
  const composeReqOpen = useCompose((s) => s.isOpen);
  const composeReqMode = useCompose((s) => s.mode);
  useEffect(() => {
    if (composeReqOpen && composeReqMode === "note") {
      setReplyTarget(null);
      setQuoteTarget(null);
      setComposerOpen("note");
    }
  }, [composeReqOpen, composeReqMode]);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  // Quote target — set when Quote is clicked on a card; the composer publishes a
  // NIP-18 quote note embedding it. Mutually exclusive with replyTarget.
  const [quoteTarget, setQuoteTarget] = useState<QuoteTarget | null>(null);
  // ⌘K / Ctrl+K opens the note composer — parity with Nav's global hotkey,
  // which can't fire here because Nav is unmounted in the chromeless
  // workspace. No-ops while the article editor overlay is up (the Glasshouse
  // supersede rule would otherwise close it under the writer mid-article) and
  // while the composer is already open — clearing reply/quote targets there
  // would silently turn a typed reply into a top-level note.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        if (useEditorOverlay.getState().isOpen) return;
        e.preventDefault();
        if (composerOpenRef.current) return;
        setReplyTarget(null);
        setQuoteTarget(null);
        setComposerOpen("note");
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
  // At most one conversation is expanded per feed. This maps a feed id to its
  // single open card: `key` (`feedItemId ?? id`) is the card slot, `root` is the
  // post the conversation is rooted on — normally the card's own post, but the
  // quoted post when the card was opened by clicking its embedded quote (so the
  // quote expands with full seniority, no trace of its host). Opening another
  // card in the same feed replaces the entry, collapsing the previous one.
  const [expandedByFeed, setExpandedByFeed] = useState<
    Record<string, { key: string; root: string }>
  >({});
  // A single global tick: bumped after a reply publishes so any open PostThread
  // busts its cache and refetches (replaces the legacy per-target refresh map).
  const [threadRefreshTick, setThreadRefreshTick] = useState(0);
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
      // Hidden feeds never render a vessel, so every [data-vessel-id] hit
      // here is a live merge target.
      const layout = store.positions[id];
      if (!layout) return;
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
    // A refresh collapses this vessel's open conversation.
    setExpandedByFeed((prev) => {
      if (!(feed.id in prev)) return prev;
      const next = { ...prev };
      delete next[feed.id];
      return next;
    });

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
      const mapped = data.items ?? [];
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
                nextCursor: data.nextCursor ?? null,
                loadingMore: false,
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

  // Infinite scroll: pull the next page of older content for a vessel and append
  // it. Guarded against concurrent / exhausted loads via the live vessel state
  // (read from the ref so the callback stays stable). New keys are de-duped
  // against what's already shown so a cursor overlap can't double a card.
  const loadMoreVesselItems = useCallback(async (feedId: string) => {
    const current = vesselsRef.current.find((v) => v.feed.id === feedId);
    if (
      !current ||
      current.status !== "ready" ||
      current.loadingMore ||
      !current.nextCursor
    ) {
      return;
    }
    const cursor = current.nextCursor;
    setVessels((prev) =>
      prev.map((v) =>
        v.feed.id === feedId ? { ...v, loadingMore: true } : v,
      ),
    );
    try {
      const data = await workspaceFeedsApi.items(feedId, { cursor });
      const mapped = data.items ?? [];
      setVessels((prev) =>
        prev.map((v) => {
          if (v.feed.id !== feedId) return v;
          const seen = new Set(v.items.map(itemKey));
          const additions = mapped.filter((m) => !seen.has(itemKey(m)));
          return {
            ...v,
            items: [...v.items, ...additions],
            nextCursor: data.nextCursor ?? null,
            loadingMore: false,
          };
        }),
      );
    } catch (err) {
      console.error("Vessel load-more error:", err);
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feedId ? { ...v, loadingMore: false } : v,
        ),
      );
    }
  }, []);

  const vesselsRef = useRef(vessels);
  vesselsRef.current = vessels;

  function refreshAll() {
    // Refreshing every vessel collapses every expanded conversation.
    setExpandedByFeed({});
    vesselsRef.current.forEach((v) => void loadVesselItems(v.feed));
  }

  function handleForallAction(key: ForallAction) {
    if (key === "new-note") {
      setReplyTarget(null);
      setQuoteTarget(null);
      setComposerOpen("note");
      return;
    }
    if (key === "new-article") {
      useEditorOverlay.getState().open();
      return;
    }
    if (key === "new-feed") {
      setNewFeedOpen(true);
      return;
    }
  }

  // Hide is feed character (MOBILE-LAYOUT-ADR §V): persisted on the feed row
  // via the PATCH, not in per-device layout state. Optimistic flip so the
  // vessel hides/returns instantly; reconcile with the server row (or revert)
  // when the PATCH settles.
  async function handleSetFeedHidden(feedId: string, hidden: boolean) {
    setVessels((prev) =>
      prev.map((v) =>
        v.feed.id === feedId ? { ...v, feed: { ...v.feed, hidden } } : v,
      ),
    );
    try {
      const { feed } = await workspaceFeedsApi.setHidden(feedId, hidden);
      setVessels((prev) =>
        prev.map((v) => (v.feed.id === feed.id ? { ...v, feed } : v)),
      );
    } catch (err) {
      console.error("Set feed hidden failed:", err);
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feedId
            ? { ...v, feed: { ...v.feed, hidden: !hidden } }
            : v,
        ),
      );
    }
  }

  function handleRestoreHiddenFeed(feedId: string) {
    void handleSetFeedHidden(feedId, false);
  }

  // Bulk re-rank (MOBILE-LAYOUT-ADR §VII.3). Optimistic: stamp the new ranks
  // locally so the badges renumber instantly, then reconcile with the
  // authoritative rows. On failure (409 = stale list) refetch the canonical
  // order rather than guessing. Rapid re-ranks (held arrow key) overlap, so
  // each call takes a sequence number and only the latest is allowed to
  // reconcile — a stale response arriving last must not revert a newer order.
  async function handleReorderFeeds(feedIds: string[]) {
    const seq = ++reorderSeqRef.current;
    const rankOf = new Map(feedIds.map((id, i) => [id, i + 1]));
    setVessels((prev) =>
      prev.map((v) => {
        const rank = rankOf.get(v.feed.id);
        return rank !== undefined
          ? { ...v, feed: { ...v.feed, sortRank: rank } }
          : v;
      }),
    );
    const applyFeeds = (feeds: WorkspaceFeed[]) => {
      if (seq !== reorderSeqRef.current) return;
      setVessels((prev) =>
        prev.map((v) => {
          const f = feeds.find((x) => x.id === v.feed.id);
          return f ? { ...v, feed: f } : v;
        }),
      );
    };
    try {
      const { feeds } = await workspaceFeedsApi.reorder(feedIds);
      applyFeeds(feeds);
    } catch (err) {
      console.error("Reorder feeds failed:", err);
      try {
        const { feeds } = await workspaceFeedsApi.list();
        applyFeeds(feeds);
      } catch {
        // Network down — leave the optimistic order; next bootstrap reconciles.
      }
    }
  }

  // The numeral is persisted rank, not creation order (MOBILE-LAYOUT-ADR
  // §VII), and numbering skips hidden feeds (§V) — visible feeds read 1..N
  // with no gaps, the same sequence the mobile pager swipes through. Hidden
  // feeds carry no numeral until restored.
  const visibleSorted = vessels
    .filter((v) => !v.feed.hidden)
    .sort(
      (a, b) =>
        a.feed.sortRank - b.feed.sortRank ||
        a.feed.createdAt.localeCompare(b.feed.createdAt) ||
        a.feed.id.localeCompare(b.feed.id),
    );
  const feedNumerals = new Map<string, number>();
  visibleSorted.forEach((v, i) => feedNumerals.set(v.feed.id, i + 1));

  function feedDisplayName(feedId: string, feedName: string): string {
    const num = feedNumerals.get(feedId) ?? 1;
    const descriptive = feedName.trim();
    return descriptive ? `Feed ${num}: ${descriptive}` : `Feed ${num}`;
  }

  const hiddenFeeds = vessels
    .filter((v) => v.feed.hidden)
    .map((v) => ({
      id: v.feed.id,
      name: v.feed.name.trim() || "Unnamed feed",
    }));

  function matchItemToSource(
    item: Post,
    sources: WorkspaceFeedSource[],
  ): string | undefined {
    // External card → its all.haus external_sources row; native → the author
    // account. (tag/publication sources have no per-card drag handle, as before.)
    if (item.externalSourceId) {
      return sources.find(
        (s) =>
          s.sourceType === "external_source" &&
          s.externalSourceId === item.externalSourceId,
      )?.id;
    }
    const authorId = item.author.accountId;
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

  // Deep-link → overlay. Retired routes (dashboard, messages, notifications)
  // redirect here as /workspace?overlay=<name>[&…seed params]; the dispatcher
  // opens the matching Glasshouse seeded from the query, then we strip the
  // params so the workspace URL stays clean. Read once on mount via
  // window.location (no useSearchParams → no Suspense boundary needed).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!openOverlayFromParams(params)) return;
    OVERLAY_PARAM_KEYS.forEach((k) => params.delete(k));
    const qs = params.toString();
    window.history.replaceState({}, "", `/reader${qs ? `?${qs}` : ""}`);
  }, []);

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

  // Bootstrap: one aggregate call returns the feed list plus, per feed, its
  // sources + first page of items (performance audit #3) — collapsing the old
  // list()+per-feed listSources()+items() fan-out into a single round trip.
  // Feeds absent from `vessels` (a freshly minted default, or a server-side
  // hydration hiccup) fall back to the per-vessel lazy loaders below.
  // Re-runs only when the authenticated user changes.
  useEffect(() => {
    if (!user || !hydrated) return;
    let cancelled = false;
    setBootstrap("loading");
    void (async () => {
      try {
        const boot = await workspaceFeedsApi.bootstrap();
        let list = boot.feeds;
        const vesselData = boot.vessels;
        let mintedFounderFeed = false;
        if (list.length === 0) {
          const { feed } = await workspaceFeedsApi.create(DEFAULT_FEED_NAME);
          list = [feed];
          mintedFounderFeed = true;
        }
        if (cancelled) return;

        // One-time hide reconciliation (MOBILE-LAYOUT-ADR §V): hide used to
        // be per-device layout state. Push any pre-migration local hides up
        // to the feed row so they don't pop back on deploy. The local flag is
        // stripped unconditionally, before the PATCH settles — a flag that
        // survived a failed PATCH would re-run the migration on a later
        // bootstrap and re-hide a feed the user has since unhidden from
        // another device. (Worst case on a transient failure: the feed stays
        // visible and the user hides it again — strictly better than the
        // reverse.) Feeds the server already has hidden need no PATCH.
        const legacyLayouts = useWorkspace.getState().positions;
        const legacyHidden = list.filter(
          (feed) => legacyLayouts[feed.id]?.hidden,
        );
        if (legacyHidden.length > 0) {
          const legacyHiddenIds = new Set(legacyHidden.map((f) => f.id));
          list = list.map((feed) =>
            legacyHiddenIds.has(feed.id) && !feed.hidden
              ? { ...feed, hidden: true }
              : feed,
          );
          for (const feed of legacyHidden) {
            useWorkspace.getState().clearLegacyHidden(feed.id);
            if (!feed.hidden) {
              workspaceFeedsApi.setHidden(feed.id, true).catch(() => {});
            }
          }
        }
        // Seed each vessel from the aggregate payload where present (ready, with
        // sources + first items + cursor); leave the rest "loading" for the
        // lazy fallback below.
        const initial: VesselState[] = list.map((feed) => {
          const v = vesselData[feed.id];
          if (v) {
            return {
              feed,
              items: v.items,
              sources: v.sources,
              status: "ready",
              nextCursor: v.nextCursor ?? null,
            };
          }
          return { feed, items: [], sources: [], status: "loading" };
        });
        setVessels(initial);
        setBootstrap("ready");

        // Fallback only for feeds the aggregate didn't cover (minted default /
        // hydration hiccup); covered feeds already carry their sources.
        for (const feed of list) {
          if (vesselData[feed.id]) continue;
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

        // Per-feed appearance (feature-debt §3 + MOBILE-LAYOUT-ADR §VI): the
        // server-side feeds.appearance is authoritative — feed character
        // travels with the feed across devices. Reconcile scheme and density
        // into the layout store, whose persisted fields double as the local
        // cache (and, for feeds that have never picked, the legacy per-device
        // fallback). One sync model for both axes, not two.
        list.forEach((feed) => {
          const scheme = feed.appearance?.scheme;
          if (scheme && stored[feed.id]?.brightness !== scheme) {
            setVesselBrightness(feed.id, normalizeBrightness(scheme));
          }
          const density = feed.appearance?.density;
          if (
            (density === "compact" ||
              density === "standard" ||
              density === "full") &&
            stored[feed.id]?.density !== density
          ) {
            setVesselDensity(feed.id, density);
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
          // Covered feeds already have their first page from the aggregate;
          // only fetch the ones the bootstrap didn't return (minted default /
          // hydration hiccup). Fire-and-forget — no need to serialise.
          if (vesselData[feed.id]) continue;
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

  // The feed's card list — shared verbatim by the desktop vessel and the
  // mobile full-bleed page (MOBILE-LAYOUT-ADR §III), so the two surfaces
  // cannot drift. Orientation never reaches the cards (it is a chassis
  // property); scheme/density/text size ride the layout store as on desktop.
  function renderFeedContents(v: VesselState) {
    const layout = positions[v.feed.id] ?? { x: 0, y: 0 };
    return (
      <>
            {v.status === "loading" && <Hint>LOADING…</Hint>}
            {v.status === "error" && <Hint>COULDN&rsquo;T LOAD FEED</Hint>}
            {v.status === "ready" &&
              v.items.length === 0 &&
              (v.sources.length === 0 ? (
                <EmptyFeedTile
                  variant="no-sources"
                  brightness={layout.brightness}
                  onAddSources={() => setFeedComposerFor(v.feed)}
                />
              ) : (
                <EmptyFeedTile
                  variant="no-items"
                  brightness={layout.brightness}
                  onAddSources={() => setFeedComposerFor(v.feed)}
                />
              ))}
            {v.status === "ready" && v.caughtUp && v.items.length > 0 && (
              <EmptyFeedTile
                variant="caught-up"
                brightness={layout.brightness}
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
              v.items.map((item) =>
                (() => {
                    // UNIVERSAL-POST-ADR Phase 5 — the unified card is the only
                    // feed path. Collapsed cards are PostCardInteractive
                    // level="feed"; expanding a note/external mounts the unified
                    // PostThread (ancestors/focal/replies on the same PostCard).
                    // Articles open the reader pane (Phase R), so they have no
                    // inline thread and stay feed cards.
                    const post = item;
                    const expandKey = item.feedItemId ?? item.id;
                    const expandedHere = expandedByFeed[v.feed.id];
                    const isExpanded = expandedHere?.key === expandKey;
                    const ctx = {
                      density: layout.density ?? DEFAULT_DENSITY,
                      palette: paletteFor(layout.brightness),
                      bodyPx:
                        TEXT_SIZE_PX[layout.textSize ?? DEFAULT_TEXT_SIZE],
                      feedId: v.feed.id,
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
                    // One conversation open per feed: opening this card
                    // replaces whatever was open in this feed; clicking the
                    // open card again collapses it.
                    const toggleExpand = () =>
                      setExpandedByFeed((prev) => {
                        if (prev[v.feed.id]?.key === expandKey) {
                          const next = { ...prev };
                          delete next[v.feed.id];
                          return next;
                        }
                        // Body click expands the host post (the quoter).
                        return {
                          ...prev,
                          [v.feed.id]: { key: expandKey, root: post.id },
                        };
                      });
                    // Clicking the embedded quote tile opens the QUOTED post as
                    // the focal of an expanded conversation — full seniority, no
                    // residue of the host that embedded it. Distinct from a body
                    // click (which expands the host): the tile stops propagation,
                    // so the two clicks never collide. The gateway minted a
                    // feed_items twin when the tile hydrated, so /thread resolves
                    // the quoted post's id (post.quotes).
                    const expandQuote = (quotedPostId: string) =>
                      setExpandedByFeed((prev) => ({
                        ...prev,
                        [v.feed.id]: { key: expandKey, root: quotedPostId },
                      }));
                    const onPipOpen = (
                      pubkey: string,
                      rect: DOMRect,
                      status: typeof post.author.pipStatus | undefined,
                    ) => setPipPanel({ pubkey, rect, status, feedId: v.feed.id });
                    // Native reply only (external interact-back is a Phase 2/3
                    // documented cut). version = the all.haus event id (vote +
                    // reply target); type picks the kind.
                    const replyFromPost = (p: Post) => {
                      setQuoteTarget(null);
                      setReplyTarget({
                        eventId: p.version ?? p.id,
                        eventKind: p.type === "article" ? 30023 : 1,
                        authorPubkey: p.author.pubkey ?? "",
                        authorName: "",
                        excerpt: (p.body.text ?? "").slice(0, 120),
                      });
                      setComposerOpen("note");
                    };
                    // Native quote → a NIP-18 quote note that embeds this post.
                    // version = the nostr event id of the thing being quoted.
                    const quoteFromPost = (p: Post) => {
                      // External post (no nostr pubkey): quote as a native note
                      // that references the origin by post_id + public URL,
                      // rendering the same rich quoted-mini (migration 102).
                      if (!p.author.pubkey) {
                        setReplyTarget(null);
                        setQuoteTarget({
                          eventId: "",
                          eventKind: 1,
                          authorPubkey: "",
                          isExternal: true,
                          quotedPostId: p.id,
                          quotedUrl: originWebUrl(p) ?? undefined,
                          quotedSource:
                            p.origin.sourceName ??
                            EXTERNAL_QUOTE_LABEL[p.origin.protocol] ??
                            p.origin.protocol.toUpperCase(),
                          previewTitle: p.body.title ?? undefined,
                          previewContent:
                            (p.body.summary ?? p.body.text ?? "").slice(0, 200) ||
                            undefined,
                          previewAuthorName:
                            p.author.displayName ?? p.author.handle ?? undefined,
                        });
                        setComposerOpen("note");
                        return;
                      }
                      const eventId = p.version ?? p.id;
                      const pubkey = p.author.pubkey ?? "";
                      // Native display names aren't on the workspace Post (the
                      // byline resolves them via useWriterName), so read that
                      // warm cache for the "Quoting …" banner; fall back to the
                      // handle, then patch in an async resolve on a cold cache.
                      const cachedName = pubkey
                        ? getCachedWriterName(pubkey)
                        : null;
                      setReplyTarget(null);
                      setQuoteTarget({
                        eventId,
                        eventKind: p.type === "article" ? 30023 : 1,
                        authorPubkey: pubkey,
                        previewTitle: p.body.title ?? undefined,
                        previewContent:
                          (p.body.summary ?? p.body.text ?? "").slice(0, 200) ||
                          undefined,
                        previewAuthorName:
                          p.author.displayName ?? cachedName ?? p.author.handle ?? undefined,
                      });
                      setComposerOpen("note");
                      if (pubkey && !p.author.displayName && !cachedName) {
                        void resolveWriterName(pubkey).then((info) => {
                          if (!info) return;
                          setQuoteTarget((prev) =>
                            prev && prev.eventId === eventId
                              ? { ...prev, previewAuthorName: info.displayName }
                              : prev,
                          );
                        });
                      }
                    };
                    // Article click → reader pane (§3.1 / Phase R). Native by
                    // d-tag (/article/<dTag>), external by URL (/read/<postId>).
                    // Actions are stable refs, so getState() avoids subscribing.
                    const openReaderFromPost = (p: Post) => {
                      const reader = useReader.getState();
                      // Frame the reader in the launching feed's wall colour
                      // (its side-wall-thick outline says "opened from this feed").
                      const frameColor = ctx.palette.walls;
                      if (p.author.pubkey) {
                        if (p.dTag)
                          reader.openNative(p.dTag, {
                            postId: p.id,
                            frameColor,
                            // Seed the instant preview from the card's Post so the
                            // reader paints title+dek on the first frame (audit #6).
                            preview: {
                              title: p.body.title,
                              summary: p.body.summary,
                            },
                          });
                      } else {
                        reader.openExternal(p.origin.uri, {
                          postId: p.id,
                          title: p.body.title,
                          siteName: p.origin.sourceName,
                          frameColor,
                        });
                      }
                    };
                    if (isExpanded && post.type !== "article") {
                      return (
                        <PostThread
                          key={item.id}
                          rootPostId={expandedHere?.root ?? post.id}
                          ctx={ctx}
                          onCollapse={toggleExpand}
                          onReply={replyFromPost}
                          onQuote={quoteFromPost}
                          onOpenReader={openReaderFromPost}
                          onPipOpen={onPipOpen}
                          refreshKey={threadRefreshTick}
                        />
                      );
                    }
                    return (
                      <PostCardInteractive
                        key={item.id}
                        post={post}
                        level="feed"
                        expanded={false}
                        ctx={ctx}
                        onPipOpen={onPipOpen}
                        onExpand={toggleExpand}
                        onQuoteOpen={expandQuote}
                        onOpenReader={openReaderFromPost}
                        onReply={
                          post.author.pubkey
                            ? () => replyFromPost(post)
                            : undefined
                        }
                        onQuote={() => quoteFromPost(post)}
                      />
                    );
                  })(),
              )}
      </>
    );
  }

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
      {bootstrap === "ready" && isMobile && (
        <MobileWorkspace
          feeds={visibleSorted.map((v) => v.feed)}
          userId={user.id}
          interiorFor={(feedId) =>
            paletteFor(positions[feedId]?.brightness).interior
          }
          renderFeedContents={(feedId) => {
            const v = vessels.find((x) => x.feed.id === feedId);
            return v ? renderFeedContents(v) : null;
          }}
          onRefresh={async (feedId) => {
            const v = vesselsRef.current.find((x) => x.feed.id === feedId);
            if (v) await loadVesselItems(v.feed);
          }}
          onLoadMore={loadMoreVesselItems}
          onOpenFeedSettings={(feedId) => {
            const v = vessels.find((x) => x.feed.id === feedId);
            if (v) setFeedComposerFor(v.feed);
          }}
        />
      )}
      {bootstrap === "ready" &&
        !isMobile &&
        vessels
          .filter((v) => !v.feed.hidden)
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
                onHide={() => void handleSetFeedHidden(v.feed.id, true)}
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
                onLoadMore={loadMoreVesselItems}
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
                {renderFeedContents(v)}
              </Vessel>
            );
          })}
      <ForallMenu
        onAction={handleForallAction}
        hiddenFeeds={hiddenFeeds}
        onRestore={handleRestoreHiddenFeed}
        anchor={isMobile ? "bar" : "floating"}
      />
      <Composer
        open={!!composerOpen}
        replyTarget={replyTarget}
        quoteTarget={quoteTarget}
        onClose={() => {
          setComposerOpen(false);
          setReplyTarget(null);
          setQuoteTarget(null);
          // Keep the global compose store (the bridge trigger) in sync so a
          // re-open request from outside this component fires the effect again.
          if (useCompose.getState().isOpen) useCompose.getState().close();
        }}
        onPublished={refreshAll}
        onReplied={() => {
          // Bump the global thread tick so an open PostThread busts its cache and
          // refetches, surfacing the just-published reply.
          setThreadRefreshTick((t) => t + 1);
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
        deleteBlocked={vessels.filter((v) => !v.feed.hidden).length <= 1}
        scheme={
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
        onSchemeChange={(next) => {
          if (!feedComposerFor) return;
          // Local store repaints the vessel immediately; the server PATCH
          // persists the scheme as feed character (cross-device). The
          // refreshed feed object keeps the vessel state in sync. On failure
          // the optimistic repaint reverts (same contract as
          // handleSetFeedHidden) — a swallowed failure would look applied
          // here and silently reset on the next bootstrap.
          const feedId = feedComposerFor.id;
          const prevScheme = positions[feedId]?.brightness;
          setVesselBrightness(feedId, next);
          workspaceFeedsApi
            .setAppearance(feedId, { scheme: next })
            .then(({ feed }) =>
              setVessels((prev) =>
                prev.map((v) => (v.feed.id === feed.id ? { ...v, feed } : v)),
              ),
            )
            .catch((err) => {
              console.error("Set feed scheme failed:", err);
              setVesselBrightness(feedId, normalizeBrightness(prevScheme));
            });
        }}
        onDensityChange={(next) => {
          if (!feedComposerFor) return;
          // Same precedence pattern as the scheme (MOBILE-LAYOUT-ADR §VI):
          // local store repaints immediately, the server PATCH persists
          // density as feed character, the refreshed row reconciles state,
          // failure reverts the repaint.
          const feedId = feedComposerFor.id;
          const prevDensity = positions[feedId]?.density;
          setVesselDensity(feedId, next);
          workspaceFeedsApi
            .setAppearance(feedId, { density: next })
            .then(({ feed }) =>
              setVessels((prev) =>
                prev.map((v) => (v.feed.id === feed.id ? { ...v, feed } : v)),
              ),
            )
            .catch((err) => {
              console.error("Set feed density failed:", err);
              setVesselDensity(feedId, prevDensity ?? DEFAULT_DENSITY);
            });
        }}
        // Orientation is a canvas property with no spatial substrate on the
        // phone (§VI) — the control doesn't render on mobile.
        onOrientationChange={
          isMobile
            ? undefined
            : (next) =>
                feedComposerFor &&
                setVesselOrientation(feedComposerFor.id, next)
        }
        onTextSizeChange={(next) =>
          feedComposerFor && setVesselTextSize(feedComposerFor.id, next)
        }
        allFeeds={vessels.map((v) => v.feed)}
        onReorder={(feedIds) => void handleReorderFeeds(feedIds)}
        hidden={
          feedComposerFor
            ? (vessels.find((v) => v.feed.id === feedComposerFor.id)?.feed
                .hidden ?? false)
            : false
        }
        onHiddenChange={(next) =>
          feedComposerFor && void handleSetFeedHidden(feedComposerFor.id, next)
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
      <ReaderOverlay />
      <MessagesOverlay />
      <DashboardOverlay />
      <LedgerOverlay />
      <SettingsOverlay />
      <LibraryOverlay />
      <NetworkOverlay />
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
        color: "var(--ah-stone-350)",
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
    <div className="label-ui py-6 text-center" style={{ color: "var(--ah-stone-350)" }}>
      {children}
    </div>
  );
}
