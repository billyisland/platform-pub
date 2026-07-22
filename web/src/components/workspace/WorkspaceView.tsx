"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import nextDynamic from "next/dynamic";
import { useAuth } from "../../stores/auth";
import { useWorkspace } from "../../stores/workspace";
import {
  findRestingPosition,
  clampSizeClear,
  type VesselRect,
} from "../../lib/workspace/collision";
import {
  snap,
  VESSEL_MIN_W,
  VESSEL_MIN_H as MIN_H,
  VESSEL_DEFAULT_W,
} from "../../lib/workspace/grid";
import { computeExtent, EDGE_PAD } from "../../lib/workspace/canvas";
import { prefersReducedMotion } from "../../lib/workspace/motion";
import {
  workspaceFeeds as workspaceFeedsApi,
  follows as followsApi,
  type WorkspaceFeed,
  type WorkspaceFeedSource,
} from "../../lib/api";
import type { PipStatus } from "../../lib/ndk";
import { Vessel } from "./Vessel";
import { ExplainProvider, useExplainable } from "./ExplainProvider";
import { useExplain } from "../../stores/explain";
import { ExplainOverlay } from "./ExplainOverlay";
import { AboutOverlay } from "./AboutOverlay";
import { PostCardInteractive } from "../post/PostCardInteractive";
import { PostThread } from "../post/PostThread";
import type { CardContext } from "../post/chassis";
import type { Post } from "../../lib/post/types";
import { originWebUrl } from "../../lib/post/origin-url";
import {
  paletteFor,
  normalizeBrightness,
  normalizeDensity,
  TEXT_SIZE_PX,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
} from "./tokens";
import { useColorScheme } from "../../stores/colorScheme";
import { ForallMenu, type ForallAction } from "./ForallMenu";
import { useMobileActiveFeed } from "../../stores/mobileActiveFeed";
import { useFeedArrivals } from "../../stores/feedArrivals";
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
import { useReader, type ReaderNavEntry } from "../../stores/reader";
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
import { useGlasshousePresence } from "../../stores/glasshouse";

const FLOOR = "var(--ah-bone)"; // grey-100 per Step 1 / Colour tokens committed
const DEFAULT_FEED_NAME = "Founder's feed";

/** Px of pan before the virtualization band is re-read (hysteresis dead band).
 *  Well under the one-viewport mount margin, so a vessel is never parked while
 *  any part of it is on screen. */
const VIRT_QUANT = 200;

// Map a feed Post to a reader-skip entry — articles only (the reader-pane click
// targets), mirroring openReaderFromPost's native/external split. Non-articles
// (notes, external short posts) expand inline and return null, so they drop out
// of the up/down skip sequence.
function articleToReaderEntry(p: Post): ReaderNavEntry | null {
  if (p.type !== "article") return null;
  if (p.author.pubkey) {
    if (!p.dTag) return null;
    return {
      kind: "native",
      postId: p.id,
      dTag: p.dTag,
      preview: { title: p.body.title, summary: p.body.summary },
    };
  }
  return {
    kind: "external",
    postId: p.id,
    url: p.origin.uri,
    title: p.body.title,
    siteName: p.origin.sourceName,
  };
}

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

// "Bring your world" (FOLLOW-GRAPH-IMPORT-ADR §7.4): the first-session import
// offer rides the same zero-feeds signal. Its seen-key is written only when
// the sheet is actually dismissed — a dark import flag renders no sheet and
// burns nothing.
const BRING_WORLD_SEEN_PREFIX = "workspace:bring_world_seen:";

// Lazy like the LazyOverlays surfaces: only brand-new accounts ever render
// this, so its chunk (resolver input + import hooks) stays out of /reader.
const BringYourWorld = nextDynamic(
  () => import("./BringYourWorld").then((m) => m.BringYourWorld),
  { ssr: false },
);

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

// MIN_H and VESSEL_DEFAULT_W come from the shared grid module (previously
// mirrored here from Vessel.tsx) so the canvas extent can be derived at
// render time from layout state alone, without a constant to keep in sync.

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
  // On mobile every feed follows the GLOBAL light/dark toggle (uniform), not
  // its per-feed scheme; on desktop feeds keep their scheme (light-islanded).
  const globalDark = useColorScheme((s) => s.dark);
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
        // Frozen floor (EXPLAIN-ADR D1): while an Explain program is active
        // nothing may open over the scrim, the composer included.
        if (useExplain.getState().isActive) return;
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
  // Drop a feed's expansion entry. Called on refresh (a reload collapses the
  // open conversation) and on delete/merge — a vessel that no longer exists
  // must not leave its key behind, or a feed later minted with the same id
  // would open pre-expanded onto a stale card.
  const clearExpandedFor = useCallback((feedId: string) => {
    setExpandedByFeed((prev) => {
      if (!(feedId in prev)) return prev;
      const next = { ...prev };
      delete next[feedId];
      return next;
    });
  }, []);
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
  const [bringWorld, setBringWorld] = useState(false);
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

  // ── Infinite horizontal floor ────────────────────────────────────────────
  // The floor pans sideways over a canvas whose extent is DERIVED from the
  // vessels on it (lib/workspace/canvas.ts). Vertical extent is the viewport,
  // always — the floor can be made wider, never taller.
  const [viewport, setViewport] = useState({ w: 1280, h: 800 });
  useEffect(() => {
    function measure() {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Slack beyond the outermost vessel, on each side. GESTURE-SCOPED: at rest
  // the floor is exactly the feeds' span plus EDGE_PAD of breathing room — no
  // empty viewport to pan into, so "infinite sideways" means the space grows
  // when a gesture asks it to, not that it is pre-stretched. While a drag is
  // live the slack widens to a full viewport so there is somewhere to drag
  // INTO; the origin shift that implies lands only at the gesture boundaries
  // (pointerdown / pointerup), where the Vessel's originX layout effect and
  // the scroll compensation below cancel it pre-paint in a single frame.
  // Contract-to-fit falls out of the extent recompute on gesture end.
  const [floorGesture, setFloorGesture] = useState(false);
  const canvasSlack = floorGesture ? Math.max(EDGE_PAD, viewport.w) : EDGE_PAD;

  const extent = useMemo(
    () =>
      computeExtent(
        vessels
          .filter((v) => !v.feed.hidden)
          .map((v) => {
            const l = positions[v.feed.id];
            return { x: l?.x ?? 0, w: l?.w ?? VESSEL_DEFAULT_W };
          }),
        viewport.w,
        canvasSlack,
      ),
    [vessels, positions, viewport.w, canvasSlack],
  );

  // Keep the floor visually still when the origin moves. Canvas-x of every
  // vessel is `store.x - originX`, so an origin that shifts left by d slides
  // all content right by d; scrolling right by the same d cancels it exactly.
  //
  // The compensation must be ABSOLUTE, from the scroll position BEFORE this
  // render committed the new canvas width. On contract-to-fit the browser has
  // already clamped scrollLeft to the narrower scrollWidth by the time this
  // layout effect runs (React mutates the DOM first), so a relative `+=` on
  // the clamped value corrects twice — the floor lurched ~a viewport on any
  // drop away from the left end, and even on a click on vessel chrome (a
  // no-move gesture still opens and closes the slack). floorScrollRef holds
  // the pre-commit position: scroll events — including the one the clamp
  // itself queues — dispatch in the rendering steps, i.e. after this effect,
  // so the ref is still pre-clamp when we read it.
  const prevOriginRef = useRef(extent.originX);
  const didInitScrollRef = useRef(false);
  const floorScrollRef = useRef(0);
  useEffect(() => {
    const floor = floorRef.current;
    if (!floor) return;
    const onScroll = () => {
      floorScrollRef.current = floor.scrollLeft;
    };
    floor.addEventListener("scroll", onScroll, { passive: true });
    return () => floor.removeEventListener("scroll", onScroll);
    // The pre-auth frame renders a Floor without the ref; re-attach once the
    // authed tree (the ref-carrying Floor) is up.
  }, [user, loading, isMobile]);
  useLayoutEffect(() => {
    const floor = floorRef.current;
    if (!floor || isMobile) return;
    if (!didInitScrollRef.current) {
      // First paint: open on the content, not on the empty left slack.
      if (vessels.length === 0) return;
      floor.scrollLeft = Math.max(0, canvasSlack - EDGE_PAD);
      floorScrollRef.current = floor.scrollLeft;
      prevOriginRef.current = extent.originX;
      didInitScrollRef.current = true;
      return;
    }
    const delta = prevOriginRef.current - extent.originX;
    if (delta !== 0) {
      floor.scrollLeft = floorScrollRef.current + delta;
      floorScrollRef.current = floor.scrollLeft;
    }
    prevOriginRef.current = extent.originX;
  }, [extent.originX, canvasSlack, isMobile, vessels.length]);

  // Ctrl+←/→ jumps the floor to its far end — the keyboard twin of panning a
  // space whose resting extent is exactly the feeds' span. Plain arrows stay
  // free (the reader's ←/→ skip, text-field caret movement); Ctrl+arrow inside
  // an editable field keeps its native word-jump, and an open Glasshouse owns
  // the keyboard.
  useEffect(() => {
    if (isMobile) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
        )
      )
        return;
      if (useGlasshousePresence.getState().isOpen) return;
      // Not while a vessel is held: scrolling the floor under a live framer
      // drag origin teleports the vessel relative to the ground and lets the
      // pointer-based merge arming read whatever scrolled under the cursor.
      if (dragActiveRef.current) return;
      const floor = floorRef.current;
      if (!floor) return;
      e.preventDefault();
      floor.scrollTo({
        left:
          e.key === "ArrowLeft" ? 0 : floor.scrollWidth - floor.clientWidth,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile]);

  const dragActiveRef = useRef<string | null>(null);
  // The vessel the pointer is currently inside during a drag — the ARMED merge
  // target (WORKSPACE-DESIGN-SPEC.md › Addendum — No-overlap governs the
  // resting state). Merge asks a POINTER question; placement asks a RECT
  // question. The dragged vessel rides freely over the whole floor (nothing
  // moves until it rests), so arming is purely about reading intent at the
  // cursor — never the dragged vessel's centre, which routinely sits over
  // things the user never aimed at.
  const [armedMergeTarget, setArmedMergeTarget] = useState<string | null>(null);
  const armedMergeTargetRef = useRef<string | null>(null);
  armedMergeTargetRef.current = armedMergeTarget;

  // ── Virtualization (WORKSPACE-COLUMN-LAYOUT-ADR §VII) ────────────────────
  // What is off-screen costs nothing: a vessel more than a viewport away keeps
  // its chassis and loses its contents. The heavy per-feed state (items,
  // nextCursor, caught-up watermark) is VesselState, here in the host, so an
  // unmount discards only the React tree, its DOM and its decoded media —
  // there is nothing to tear down and nothing to refetch (the client holds no
  // relay connections; content arrives over the gateway REST API).
  //
  // The band is measured in STORE space, keyed off `panOffset = scrollLeft +
  // originX`. That sum is INVARIANT under the gesture-slack origin shift
  // (originX moves by −d, the compensation effect above moves scrollLeft by
  // +d), so beginning a drag cannot transiently mis-read the band and unmount
  // half the floor mid-gesture. A dead band of VIRT_QUANT px of pan before the
  // set is re-read supplies the hysteresis: a vessel straddling the boundary
  // needs a real scroll, not a jitter, to flip.
  const [panOffset, setPanOffset] = useState(0);
  const panOffsetRef = useRef(0);
  const originXRef = useRef(extent.originX);
  originXRef.current = extent.originX;
  const virtRafRef = useRef<number | null>(null);
  const syncPan = useCallback(() => {
    const floor = floorRef.current;
    if (!floor) return;
    const next = floor.scrollLeft + originXRef.current;
    if (Math.abs(next - panOffsetRef.current) < VIRT_QUANT) return;
    panOffsetRef.current = next;
    setPanOffset(next);
  }, []);
  useEffect(() => {
    const floor = floorRef.current;
    if (!floor || isMobile) return;
    function onScroll() {
      if (virtRafRef.current !== null) return;
      virtRafRef.current = requestAnimationFrame(() => {
        virtRafRef.current = null;
        syncPan();
      });
    }
    floor.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      floor.removeEventListener("scroll", onScroll);
      if (virtRafRef.current !== null)
        cancelAnimationFrame(virtRafRef.current);
      virtRafRef.current = null;
    };
    // Same re-attach reason as the floorScrollRef listener above: the pre-auth
    // frame renders a Floor without the ref.
  }, [user, loading, isMobile, syncPan]);
  // Cold start and layout changes. The dead band only fires on real scroll
  // events, and the first-paint scroll init sets scrollLeft without dispatching
  // one — so a workspace whose feeds all sit far from store-x 0 would otherwise
  // start with an empty band. Declared AFTER the origin-compensation layout
  // effect so it always reads a scrollLeft that has already been corrected.
  useLayoutEffect(() => {
    if (isMobile) return;
    syncPan();
  }, [isMobile, syncPan, extent.originX, vessels.length, bootstrap]);

  const visibleIds = useMemo(() => {
    const lo = panOffset - viewport.w;
    const hi = panOffset + viewport.w * 2;
    const ids = new Set<string>();
    for (const v of vessels) {
      if (v.feed.hidden) continue;
      const l = positions[v.feed.id];
      const x = l?.x ?? 0;
      const w = l?.w ?? VESSEL_DEFAULT_W;
      if (x + w >= lo && x <= hi) ids.add(v.feed.id);
    }
    return ids;
  }, [vessels, positions, panOffset, viewport.w]);

  /**
   * Read the floor's live geometry in STORE coordinates. `exclude` drops the
   * vessel being acted on; a vessel with no stored layout is skipped, since it
   * has no store-space position to reason about.
   */
  function readFloorRects(exclude: string): {
    floor: HTMLDivElement;
    others: VesselRect[];
  } | null {
    const floor = floorRef.current;
    if (!floor) return null;
    const store = useWorkspace.getState();
    const others: VesselRect[] = [];
    floor.querySelectorAll<HTMLElement>("[data-vessel-id]").forEach((el) => {
      const id = el.dataset.vesselId!;
      if (id === exclude) return;
      // A vessel hidden for a ceremony still renders (opacity 0), so it is in
      // the DOM but is not on the floor as far as the user is concerned — it
      // must neither be pushed nor be a merge target.
      if (el.dataset.vesselInert === "true") return;
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
    return { floor, others };
  }

  /**
   * Bring one vessel to rest without disturbing anything else: mover-yields.
   * The vessel settles at the nearest clear spot to where the gesture left it
   * — obstacles NEVER move, so a drop can't bounce a neighbour aside. Every
   * gesture that produces a resting position owes this — drag and the
   * declined-merge path alike (resize keeps the invariant from the other
   * side, by clamping the stretch at neighbours).
   */
  const settleMoverAt = useCallback(
    (feedId: string, pos: { x: number; y: number }) => {
      const read = readFloorRects(feedId);
      if (!read) {
        setVesselPosition(feedId, pos);
        return;
      }
      const { floor, others } = read;
      const moverEl = floor.querySelector<HTMLElement>(
        `[data-vessel-id="${feedId}"]`,
      );
      if (!moverEl) {
        setVesselPosition(feedId, pos);
        return;
      }

      const mover: VesselRect = {
        id: feedId,
        x: pos.x,
        y: pos.y,
        w: moverEl.offsetWidth,
        h: moverEl.offsetHeight,
      };

      // Vertical bound only — the mover may settle at any x (the canvas grows
      // to cover it); bounding x would pin it to the viewport edge.
      setVesselPosition(
        feedId,
        findRestingPosition(mover, others, { h: floor.clientHeight }),
      );
    },
    [setVesselPosition],
  );

  /**
   * Resize twin of settleMoverAt: the stretch is clamped at the first
   * neighbour it would hit, so a resize never displaces anything — not the
   * neighbours, and not the resized vessel, whose anchored edge the user
   * placed deliberately. Applied on every resize frame (the handle visibly
   * stops at the neighbour), so the committed size is clear by construction.
   */
  const clampVesselResize = useCallback(
    (
      feedId: string,
      start: { w: number; h: number },
      proposed: { w: number; h: number },
    ) => {
      const read = readFloorRects(feedId);
      const layout = useWorkspace.getState().positions[feedId];
      if (!read || !layout) return proposed;
      return clampSizeClear(
        { x: layout.x, y: layout.y },
        start,
        proposed,
        read.others,
      );
    },
    // readFloorRects only touches refs and store getState — stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function handleVesselDragStart(feedId: string) {
    dragActiveRef.current = feedId;
    // D11 drag-suspension seam (inert under the frozen floor; see explain.ts).
    if (useExplain.getState().isActive) useExplain.getState().setDragging(feedId);
  }

  function handleVesselDragFrame(
    feedId: string,
    pos: { x: number; y: number },
    pointer: { x: number; y: number },
  ) {
    const floor = floorRef.current;
    if (!floor) return;

    // Merge arming — a POINTER hit-test, in viewport space. The dragged
    // vessel's centre is the wrong probe: a vessel is grabbed by its numeral in
    // the bottom-left corner as readily as anywhere else, so its centre
    // routinely sits over something the user never aimed at.
    let armed: string | null = null;
    floor.querySelectorAll<HTMLElement>("[data-vessel-id]").forEach((el) => {
      const id = el.dataset.vesselId!;
      if (id === feedId || armed) return;
      if (el.dataset.vesselInert === "true") return;
      const r = el.getBoundingClientRect();
      if (
        pointer.x >= r.left &&
        pointer.x <= r.right &&
        pointer.y >= r.top &&
        pointer.y <= r.bottom
      ) {
        armed = id;
      }
    });
    if (armed !== armedMergeTargetRef.current) setArmedMergeTarget(armed);
    // No placement work mid-drag: the held vessel rides over the floor (raised
    // z-order) and nothing else moves. The invariant is a RESTING-state rule,
    // settled once on release.
  }

  function handleVesselDragEnd(feedId: string, pos: { x: number; y: number }) {
    dragActiveRef.current = null;
    if (useExplain.getState().draggingFeedId) useExplain.getState().setDragging(null);

    const armed = armedMergeTargetRef.current;
    setArmedMergeTarget(null);

    if (armed) {
      const source = vessels.find((v) => v.feed.id === feedId);
      const target = vessels.find((v) => v.feed.id === armed);
      if (source && target) {
        // Left overlapping on purpose, pending the answer. Whichever way the
        // confirmation goes, the source settles before it comes to rest.
        setVesselPosition(feedId, pos);
        setPendingMerge({ source: source.feed, target: target.feed });
        return;
      }
    }

    settleMoverAt(feedId, pos);
  }

  /**
   * The merge did not happen — declined, or it failed. The source vessel is
   * sitting on top of the target because the gesture aimed it there, so the
   * invariant has to be restored now: this is the cancel path that keeps "no
   * overlap in any scenario" true rather than usually-true. Mover-yields makes
   * it read right too — the vessel the user dragged slides off; the target
   * they declined to merge into stays put.
   */
  const settleAfterAbandonedMerge = useCallback(
    (sourceId: string) => {
      const layout = useWorkspace.getState().positions[sourceId];
      if (!layout) return;
      settleMoverAt(sourceId, { x: layout.x, y: layout.y });
    },
    [settleMoverAt],
  );

  async function handleMergeConfirm() {
    if (!pendingMerge) return;
    const { source, target } = pendingMerge;
    // A failed merge REJECTS to the dialog, which owns failure: it stays open,
    // paints the error line, and offers retry; its Cancel/Escape path runs
    // settleAfterAbandonedMerge via onClose, restoring the no-overlap
    // invariant. Clearing pendingMerge here on error unmounted the dialog
    // before its error state could ever paint — a failed merge read as a
    // silent close.
    await workspaceFeedsApi.merge(target.id, source.id);
    setVessels((prev) => {
      const next = prev.filter((v) => v.feed.id !== source.id);
      const targetVessel = next.find((v) => v.feed.id === target.id);
      if (targetVessel) void loadVesselItems(targetVessel.feed);
      return next;
    });
    removeVesselLayout(source.id);
    clearExpandedFor(source.id);
    setPendingMerge(null);
  }

  const loadVesselItems = useCallback(async (feed: WorkspaceFeed) => {
    // A refresh collapses this vessel's open conversation.
    clearExpandedFor(feed.id);

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
  }, [clearExpandedFor]);

  // Feed ids with a load-more request in flight. This is the CONCURRENCY guard;
  // the vessel's own `loadingMore` field is presentation only (it drives the
  // spinner). React state can't guard here: `vesselsRef` only catches up on
  // re-render, so two scroll events firing in the same tick would both read
  // `loadingMore: false` and fetch the same cursor twice, appending a duplicate
  // page. A ref latch flips synchronously, so the second call returns early.
  const loadingMoreRef = useRef<Set<string>>(new Set());

  // Infinite scroll: pull the next page of older content for a vessel and append
  // it. Guarded against exhausted loads via the live vessel state (read from the
  // ref so the callback stays stable) and against concurrent loads via the latch
  // above. New keys are de-duped against what's already shown so a cursor
  // overlap can't double a card.
  const loadMoreVesselItems = useCallback(async (feedId: string) => {
    const current = vesselsRef.current.find((v) => v.feed.id === feedId);
    if (
      !current ||
      current.status !== "ready" ||
      loadingMoreRef.current.has(feedId) ||
      !current.nextCursor
    ) {
      return;
    }
    loadingMoreRef.current.add(feedId);
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
    } finally {
      loadingMoreRef.current.delete(feedId);
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
    // While hidden, this feed was not an obstacle — the user may have legally
    // arranged the floor over its stored ground. The returner yields like any
    // mover: settle it against the CURRENT floor before it re-renders, so
    // nothing visible moves and the restore cannot mint a resting overlap.
    // Sizes fall back to the same conservative estimates as the store's
    // reconcile heal (intrinsic height is unknowable without the DOM).
    const layout = useWorkspace.getState().positions[feedId];
    const read = readFloorRects(feedId);
    if (layout && read) {
      const pos = findRestingPosition(
        {
          id: feedId,
          x: layout.x,
          y: layout.y,
          w: Math.max(layout.w ?? VESSEL_DEFAULT_W, VESSEL_MIN_W),
          h: layout.h ?? MIN_H,
        },
        read.others,
        { h: read.floor.clientHeight },
      );
      if (pos.x !== layout.x || pos.y !== layout.y)
        setVesselPosition(feedId, pos);
    }
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

  // The feed the ∀ relativises to: the mobile pager's active feed, resolved to
  // a live + still-visible row. A stale id (feed since hidden/deleted) yields
  // null, so the feed-scoped row simply drops out. Desktop never sets the store
  // (no single active feed), so this stays null there.
  const mobileActiveFeedId = useMobileActiveFeed((s) => s.feedId);
  const currentFeed =
    isMobile && mobileActiveFeedId
      ? (visibleSorted.find((v) => v.feed.id === mobileActiveFeedId)?.feed ??
        null)
      : null;

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

  // Adopt a feed minted server-side (the NewFeedPrompt create, or a feed
  // announced from outside this component — a follow-graph import started in
  // the Settings overlay / FeedComposer) into a live vessel. Idempotent: a
  // feed already showing is left alone. The membership check and the store
  // writes stay OUTSIDE the setVessels updater — an impure updater only
  // behaves while React evaluates it eagerly, and the multi-feed drain loop
  // below queues updates, deferring later updaters to the render phase. The
  // ref append keeps same-tick loop calls deduped with sequential grid slots
  // (the updater still re-checks membership itself, so it stays pure and
  // double-invocation-safe).
  function adoptFeed(feed: WorkspaceFeed) {
    if (vesselsRef.current.some((v) => v.feed.id === feed.id)) return;
    vesselsRef.current = [
      ...vesselsRef.current,
      { feed, items: [], sources: [], status: "loading" as const },
    ];
    setVessels((prev) =>
      prev.some((v) => v.feed.id === feed.id)
        ? prev
        : [...prev, { feed, items: [], sources: [], status: "loading" as const }],
    );
    const slot = defaultGridSlot(
      vesselsRef.current.length - 1,
      window.innerWidth,
      window.innerHeight,
    );
    // The index-derived slot is only a REQUEST — the user may have arranged a
    // vessel over it. The newcomer yields like any mover (no-overlap governs
    // the resting state, and a system-minted vessel earns it the same way):
    // it settles at the nearest clear spot, and nothing on the floor moves.
    const read = readFloorRects(feed.id);
    const pos = read
      ? findRestingPosition(
          { id: feed.id, x: slot.x, y: slot.y, w: VESSEL_DEFAULT_W, h: slot.h },
          read.others,
          { h: read.floor.clientHeight },
        )
      : slot;
    setVesselPosition(feed.id, pos);
    setVesselSize(feed.id, { w: VESSEL_DEFAULT_W, h: slot.h });
    void loadVesselItems(feed);
  }

  // Drain feeds announced by out-of-component creators (follow-graph imports,
  // FOLLOW-GRAPH-IMPORT-ADR §7) so the new vessel appears immediately.
  const pendingArrivals = useFeedArrivals((s) => s.pending);
  useEffect(() => {
    if (pendingArrivals.length === 0) return;
    pendingArrivals.forEach(adoptFeed);
    // Consume only the drained snapshot — an announce landing between render
    // and this effect stays queued for the next run instead of being wiped.
    useFeedArrivals.getState().consume(pendingArrivals);
    // adoptFeed is a stable-enough plain function (dedup via vesselsRef); the
    // queue itself is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingArrivals]);

  async function handleCreateFeed(name: string) {
    const { feed } = await workspaceFeedsApi.create(name);
    adoptFeed(feed);
    setNewFeedOpen(false);
    // TODO: re-enable / refine entrance animation
    // setCeremony({ feedId: feed.id, pace: "responsive", target: slot });
  }

  useEffect(() => {
    if (!loading && !user) router.push("/auth?mode=login");
  }, [user, loading, router]);

  // Deep-link → overlay. Retired routes (dashboard, messages, notifications)
  // redirect here as /reader?overlay=<name>[&…seed params]; so do the standalone
  // pane pages on reload (WorkspacePaneRedirect → ?overlay=reader|profile|surface).
  // We strip the seed params and clean the URL to /reader *first*, then open the
  // overlay — the order matters for the pane overlays (reader/profile/surface),
  // which push their own canonical URL on open: opening after the strip lands that
  // URL on a clean /reader base entry, so Back/close returns to the workspace
  // rather than the seed URL. The ?overlay= panels push no URL, so the order is
  // harmless for them. Read once on mount via window.location (no useSearchParams
  // → no Suspense boundary needed).
  useEffect(() => {
    const seed = new URLSearchParams(window.location.search);
    if (!seed.get("overlay")) return;
    const cleaned = new URLSearchParams(window.location.search);
    OVERLAY_PARAM_KEYS.forEach((k) => cleaned.delete(k));
    const qs = cleaned.toString();
    window.history.replaceState({}, "", `/reader${qs ? `?${qs}` : ""}`);
    openOverlayFromParams(seed);
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

        // The authoritative feed list is now known — reconcile persisted
        // layouts against it: prune ghosts (feeds deleted on another device;
        // removeVessel only ever ran locally) and heal resting overlaps among
        // VISIBLE feeds only. The heal used to run blind at hydrate, where the
        // store cannot know hidden/deleted — a vessel legally resting over a
        // hidden feed's stored rect got shelved as a false-positive pile.
        useWorkspace.getState().reconcileLayouts(
          list.map((f) => f.id),
          list.filter((f) => !f.hidden).map((f) => f.id),
        );

        const stored = useWorkspace.getState().positions;
        const viewportWidth =
          typeof window !== "undefined" ? window.innerWidth : 1280;
        const viewportHeight =
          typeof window !== "undefined" ? window.innerHeight : 800;
        // Default slots are REQUESTS, cleared against the floor before they
        // land: a stored (user-arranged) vessel may occupy the index-derived
        // slot, and a system write must not mint a resting overlap. The DOM
        // isn't up yet, so obstacles come from stored layouts with the same
        // conservative size estimates as the reconcile heal; slotted feeds
        // join the obstacle set so same-boot siblings clear each other too.
        const obstacles: VesselRect[] = list
          .filter((f) => !f.hidden && stored[f.id])
          .map((f) => {
            const l = stored[f.id];
            return {
              id: f.id,
              x: l.x,
              y: l.y,
              w: Math.max(l.w ?? VESSEL_DEFAULT_W, VESSEL_MIN_W),
              h: l.h ?? MIN_H,
            };
          });
        list.forEach((feed, i) => {
          if (!stored[feed.id]) {
            const slot = defaultGridSlot(i, viewportWidth, viewportHeight);
            const pos = findRestingPosition(
              {
                id: feed.id,
                x: slot.x,
                y: slot.y,
                w: VESSEL_DEFAULT_W,
                h: slot.h,
              },
              obstacles,
              { h: viewportHeight },
            );
            setVesselPosition(feed.id, pos);
            setVesselSize(feed.id, { w: VESSEL_DEFAULT_W, h: slot.h });
            if (!feed.hidden) {
              obstacles.push({
                id: feed.id,
                x: pos.x,
                y: pos.y,
                w: VESSEL_DEFAULT_W,
                h: slot.h,
              });
            }
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
          if (feed.appearance?.density !== undefined) {
            const density = normalizeDensity(feed.appearance.density);
            if (stored[feed.id]?.density !== density) {
              setVesselDensity(feed.id, density);
            }
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

        // "Bring your world" (ADR §7.4): same first-session signal as the
        // ceremony, its own seen-key (written on dismiss, not here — a dark
        // import flag renders no sheet and must not consume the one shot).
        // Skipped when a deep-linked overlay already claimed the Glasshouse —
        // superseding what the user explicitly navigated to would be rude.
        if (
          mintedFounderFeed &&
          typeof window !== "undefined" &&
          window.localStorage.getItem(
            `${BRING_WORLD_SEEN_PREFIX}${user.id}`,
          ) !== "true" &&
          !useGlasshousePresence.getState().isOpen
        ) {
          setBringWorld(true);
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
    // Both surfaces render the feed's colourway in the global mode's light or
    // dark variant. Desktop vessels and the mobile pages are both islanded
    // (LIGHT_ISLAND_STYLE), so the derived text slugs the palette references
    // resolve canonical regardless of mode and the variant supplies light/dark.
    const feedPalette = paletteFor(layout.brightness, globalDark);
    return (
      <>
            {v.status === "loading" && <Hint>LOADING…</Hint>}
            {v.status === "error" && <Hint>COULDN&rsquo;T LOAD FEED</Hint>}
            {v.status === "ready" &&
              v.items.length === 0 &&
              (v.sources.length === 0 ? (
                <EmptyFeedTile
                  variant="no-sources"
                  palette={feedPalette}
                  onAddSources={() => setFeedComposerFor(v.feed)}
                />
              ) : (
                <EmptyFeedTile
                  variant="no-items"
                  palette={feedPalette}
                  onAddSources={() => setFeedComposerFor(v.feed)}
                />
              ))}
            {v.status === "ready" && v.caughtUp && v.items.length > 0 && (
              <EmptyFeedTile
                variant="caught-up"
                palette={feedPalette}
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
                      // Mobile: uniform global light/dark; desktop: the feed's
                      // colourway in the global mode's light/dark variant.
                      palette: feedPalette,
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
                      // Frame the reader in the launching feed's wall colour, and
                      // hand it the feed's article list so the skip ears step
                      // through them in place (the launching feed's bar-text tone
                      // colours the ear arrows).
                      const frame = {
                        frameColor: ctx.palette.walls,
                        frameTextColor: ctx.palette.barText,
                      };
                      const entries = v.items
                        .map(articleToReaderEntry)
                        .filter((e): e is ReaderNavEntry => e !== null);
                      const index = entries.findIndex((e) => e.postId === p.id);
                      if (index >= 0) {
                        reader.openFeedItem(entries, index, frame);
                        return;
                      }
                      // Not in the feed list (e.g. an article quoted inside a
                      // thread) — open it without the skip ears.
                      const entry = articleToReaderEntry(p);
                      if (entry?.kind === "native")
                        reader.openNative(entry.dTag, {
                          postId: entry.postId,
                          frameColor: frame.frameColor,
                          preview: entry.preview,
                        });
                      else if (entry?.kind === "external")
                        reader.openExternal(entry.url, {
                          postId: entry.postId,
                          title: entry.title,
                          siteName: entry.siteName,
                          frameColor: frame.frameColor,
                        });
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
    // ExplainProvider holds the registration Map (EXPLAIN-ADR §8). It wraps the
    // whole floor; registration is inert on the mobile branch (MobileWorkspace
    // renders no Vessel roots), and the Explain overlay + first-run entry effect
    // that later slices add mount on the desktop path only.
    <ExplainProvider>
      <Floor floorRef={floorRef}>
      {bootstrap === "loading" && (
        <CenteredHint>BOOTSTRAPPING WORKSPACE…</CenteredHint>
      )}
      {bootstrap === "error" && (
        <CenteredHint>COULDN&rsquo;T LOAD WORKSPACE</CenteredHint>
      )}
      {bootstrap === "ready" && isMobile && (
        <MobileWorkspace
          // Rank order, same as the desktop numerals: leftmost pip = Feed 1,
          // counting up left-to-right, so the pip's positional aria-label and
          // the FeedComposer title it opens always agree. (A 2026-07-04
          // `.reverse()` here did the OPPOSITE of its stated "Feed 1 leftmost"
          // intent — visibleSorted already runs Feed 1 first; removed
          // 2026-07-06, MOBILE-LAYOUT-ADR §X.)
          feeds={visibleSorted.map((v) => v.feed)}
          userId={user.id}
          interiorFor={(feedId) =>
            paletteFor(positions[feedId]?.brightness, globalDark).interior
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
      {/* The canvas: an explicitly-sized plane inside the scrolling floor.
          Width is derived from the vessels on it, height is always the
          viewport. Vessels are absolutely positioned in CANVAS coordinates
          (store x minus the extent origin); every other consumer of position —
          collision, merge hit-testing, persistence — stays in store space, and
          the conversion happens only at this seam. */}
      {bootstrap === "ready" && !isMobile && (
        <div
          data-workspace-canvas
          style={{
            position: "relative",
            width: extent.width,
            height: "100%",
            // Confine vessel z-order (the drag/armed raise in Vessel.tsx) to
            // the canvas. The idle ∀ disc runs at z-index:auto in lens mode
            // (FORALL-CUT-AND-LOCKUP-ADR §IV.5 — any z-index between disc and
            // feed breaks the difference blend), so without this a raised
            // vessel would paint OVER the disc; isolated, the canvas flattens
            // into one unit the later-in-DOM ForallMenu paints above, and one
            // backdrop the lens inverts.
            isolation: "isolate",
          }}
        >
          {vessels
            .filter((v) => !v.feed.hidden)
            .map((v) => {
              const layout = positions[v.feed.id] ?? { x: 0, y: 0 };
              return (
              <Vessel
                key={v.feed.id}
                feedId={v.feed.id}
                numeral={feedNumerals.get(v.feed.id) ?? 1}
                descriptiveName={v.feed.name || undefined}
                sortRank={v.feed.sortRank}
                fromStarter={v.feed.fromStarter}
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
                // store → canvas
                position={{ x: layout.x - extent.originX, y: layout.y }}
                originX={extent.originX}
                onFloorGesture={setFloorGesture}
                size={{ w: layout.w, h: layout.h }}
                brightness={layout.brightness}
                orientation={layout.orientation}
                onHide={() => void handleSetFeedHidden(v.feed.id, true)}
                // canvas → store
                onPositionCommit={(next) =>
                  handleVesselDragEnd(v.feed.id, {
                    x: next.x + extent.originX,
                    y: next.y,
                  })
                }
                // A stretch produces a resting state exactly as a drop does.
                // clampResize keeps every frame of it clear (the handle stops
                // at neighbours), so the commit is clear by construction.
                onSizeCommit={(next) => setVesselSize(v.feed.id, next)}
                clampResize={(start, proposed) =>
                  clampVesselResize(v.feed.id, start, proposed)
                }
                onDragStart={() => handleVesselDragStart(v.feed.id)}
                onDragFrame={(pos, pointer) =>
                  handleVesselDragFrame(
                    v.feed.id,
                    { x: pos.x + extent.originX, y: pos.y },
                    pointer,
                  )
                }
                armed={armedMergeTarget === v.feed.id}
                contentsMounted={visibleIds.has(v.feed.id)}
                hidden={ceremony?.feedId === v.feed.id}
                floorRef={floorRef}
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
        </div>
      )}
      <ForallMenu
        onAction={handleForallAction}
        hiddenFeeds={hiddenFeeds}
        onRestore={handleRestoreHiddenFeed}
        currentFeed={
          currentFeed ? { id: currentFeed.id, name: currentFeed.name } : null
        }
        onFeedSettings={(feedId) => {
          const v = vessels.find((x) => x.feed.id === feedId);
          if (v) setFeedComposerFor(v.feed);
        }}
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
          clearExpandedFor(feedId);
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
        onClose={() => {
          const sourceId = pendingMerge?.source.id;
          setPendingMerge(null);
          if (sourceId) settleAfterAbandonedMerge(sourceId);
        }}
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
      {bringWorld && (
        <BringYourWorld
          onClose={() => {
            setBringWorld(false);
            if (user && typeof window !== "undefined") {
              try {
                window.localStorage.setItem(
                  `${BRING_WORLD_SEEN_PREFIX}${user.id}`,
                  "true",
                );
              } catch {
                // Quota / private browsing — worst case the offer shows once
                // more, which is harmless (it never imports by itself).
              }
            }
          }}
        />
      )}
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
      {/* Desktop only — the Explain engine must never mount on the mobile
          branch (EXPLAIN build-plan §2, ADR §Surface). AboutOverlay mounts on
          BOTH branches: desktop reaches it via the menu's About row and the D3
          chrome-swap button; mobile via its menu's About row (the slot Explain
          would occupy — no hover branch there), rendering as a full-screen
          sheet the disc-X dismisses. */}
      {!isMobile && <ExplainOverlay />}
      <AboutOverlay />
      {/* First-run auto-entry (D6) is DORMANT (2026-07-15): auto-dropping a
          fresh device into Explain on load proved disorienting on the live
          site, so the six-beat tour no longer mounts — Explain is strictly
          ∀-menu-invoked. Revive by remounting <FirstRunController userId
          armed={bootstrap === "ready" && !ceremony && !bringWorld} /> here
          (ExplainProvider.tsx keeps the controller + program intact). */}
      </Floor>
    </ExplainProvider>
  );
}

function Floor({
  children,
  floorRef,
}: {
  children?: React.ReactNode;
  floorRef?: React.RefObject<HTMLDivElement>;
}) {
  // Register the floor as an explainable root (EXPLAIN-ADR D4). Inert outside an
  // ExplainProvider (the loading/redirect Floor), so this is a no-op there.
  const ref = useExplainable("floor", { ref: floorRef });
  return (
    <div
      ref={ref}
      className="scroll-silent"
      style={{
        background: FLOOR,
        minHeight: "100vh",
        height: "100vh",
        position: "relative",
        // The floor is the scroll VIEWPORT onto an infinitely-wide canvas:
        // pans sideways, never taller than the screen. Deliberately NOT a CSS
        // transform — a transform here would establish a containing block and
        // capture the position:fixed ∀ chrome (and the mobile bar), dragging
        // them around with the canvas instead of leaving them pinned.
        overflowX: "auto",
        overflowY: "hidden",
        overscrollBehaviorX: "contain",
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
