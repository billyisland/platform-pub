"use client";

// =============================================================================
// Glasshouse — the canonical "frosted overlay over the workspace" primitive.
//
// One shape, reused everywhere a surface opens *over* the workspace (the reader
// pane, direct messages, future panels):
//   - a full-viewport frosted scrim (z-[55], `.gh-scrim`) — backdrop blur PLUS a
//     desaturate + neutral wash that converges any per-feed scheme behind toward
//     the mode's ground, so the pane always meets the same field (separation is
//     the scrim's job — GLASSHOUSE-AND-PALETTE-ADR §III.1); click-to-close;
//   - a pale parchment pane (z-[56], `bg-glasshouse` = #F5F4F0) lifted by an
//     elevation shadow alone (no top edge), click-through guarded. The pane is
//     LIGHTER than both the bone floor and the washed scrim ground, so it reads
//     as lifted paper (the identity is the pane's — §III.2); fields inside it are
//     the brighter white wells. It opens snapped-centred on the 20px lattice and
//     is DRAGGABLE by any empty part of itself (the top-centre grip is just the
//     discoverable affordance; a pointerdown on margins/chrome drags too, while
//     prose stays highlightable and controls stay live — see isDragSurface) —
//     drag is free, snaps to the lattice on release, clamps to
//     the viewport, and (with `persistKey`) remembers its spot per overlay. It
//     stays modal throughout: the scrim, one-at-a-time, and scroll-lock are
//     unchanged; only the single pane's placement is now user-chosen;
//   - Escape closes; body scroll is locked while mounted.
//
// The ForallMenu lives separately at z-60, so it floats CRISP above the frost
// as the sole nav affordance — that crispness is the whole point of the
// pattern and is preserved simply by Glasshouse never reaching z-60.
//
// Glasshouse owns only the chrome. URL-sync / history behaviour (the reader's
// shareable /article·/reader entries) is layered on top by the caller's store,
// not here. Mount it conditionally — it runs its scroll-lock on mount/unmount.
//
// Separation inside the pane is whitespace + the slab rules, per the sitewide
// no-thin-line rule; the 6px slab top and the elevation shadow are not lines.
//
// INVARIANT — one Glasshouse at a time. Frosted panes never stack: opening any
// Glasshouse supersedes whichever was open before. This is enforced here, in the
// primitive, so every surface participates automatically (incl. the workspace-
// local Composer / FeedComposer driven by local state, not a store). The active
// instance is tracked module-level; a newly-mounted pane closes the previous one
// via its `supersede` callback. `supersede` is a STATE-ONLY close (never
// history.back): for URL-synced overlays (reader / profile / surface) the caller
// passes `onSupersede={dismiss}`, because the newcomer already owns the top
// history entry and a history.back here would pop *its* URL, not the old pane's.
// Ephemeral overlays omit it — their onClose is already state-only.
// =============================================================================

import React, { useEffect, useRef, useState } from "react";
import { snap } from "../../lib/workspace/grid";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useGlasshousePresence } from "../../stores/glasshouse";
import { useExplain } from "../../stores/explain";
import { useBackGuard } from "../../lib/backGuard";
import { isDragSurface } from "../../lib/dragSurface";
import { MOBILE_BAR_H } from "./MobileWorkspace";
import { NAV_ROW_H } from "./NavRow";

// Gutter between the pane and the viewport edge, on the 20px lattice.
const MARGIN = 20;
// Floors for a resizable pane (the writers). On the 20px lattice.
const MIN_W = 320;
const MIN_H = 240;

// Feed-launched frame geometry — an INVERTED, thinner echo of the feed vessel.
// The vessel is ⊔ (8px side walls + a 32px bottom bar). The reader frame is its
// inversion ⊓: a top bar + narrow side rules, open at the bottom — all thinner
// than the vessel's own walls. Drawn as a colour overlay (not borders) so it
// never disturbs the pane's width / scroll geometry, sitting in the content's
// top + side padding gutters. Both dimensions clear the banned single-pixel range.
const FRAME_TOP = 8; // top-bar thickness (the substantial bar; reads above the rules)
const FRAME_SIDE = 4; // side-rule thickness
// Skip "ears": half-circle tabs that protrude from the pane's left/right edges,
// each carrying a triangular arrow — the up/down feed-skip buttons. Coloured the
// frame colour; the arrow takes the frame's contrast tone.
const EAR_R = 22; // ear radius (protrusion depth = EAR_R, height = 2·EAR_R)
const EAR_ARROW = 7; // arrow half-width / height

const clampN = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

// Whole-pane drag (the user can grab the window by any "empty" part of it, not
// just the top grip). A pointerdown on the pane starts a drag UNLESS it landed
// on something already doing its own thing: an interactive control, selectable
// text, or a native scrollbar gutter. So the margins move the window while the
// article prose stays highlightable and links/buttons stay clickable. The
// judgment lives in the shared `isDragSurface` helper (also used by the feed
// card's drag-to-another-feed).

// Persisted drag position, keyed per overlay so each surface remembers its own
// spot between appearances. Best-effort — storage can throw (private mode, quota).
const posStoreKey = (key: string) => `ah:overlay-pos:${key}`;
function readPos(key: string): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(posStoreKey(key));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === "number" && typeof p?.y === "number") return p;
  } catch {
    /* ignore */
  }
  return null;
}
function writePos(key: string, pos: { x: number; y: number }) {
  try {
    localStorage.setItem(posStoreKey(key), JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

// Persisted pane size, for resizable overlays. Separate key from position so the
// two gestures (drag, stretch) persist independently.
const sizeStoreKey = (key: string) => `ah:overlay-size:${key}`;
function readSize(key: string): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(sizeStoreKey(key));
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (typeof s?.w === "number" && typeof s?.h === "number") return s;
  } catch {
    /* ignore */
  }
  return null;
}
function writeSize(key: string, size: { w: number; h: number }) {
  try {
    localStorage.setItem(sizeStoreKey(key), JSON.stringify(size));
  } catch {
    /* ignore */
  }
}

// Placement of the pane: a draggable, grid-snapped, viewport-clamped position
// that persists per overlay.
//
// The default position is the snapped centre. Flex `justify-center` lands a
// fixed-width pane on a half-pixel left edge whenever the viewport width is odd,
// rendering the pane edges and all its interior text faintly fuzzy; computing the
// offset and snapping it to the 20px lattice kills the sub-pixel blur and puts the
// pane on the same grid as the vessels behind it.
//
// Drag is free (smooth) and snaps to the lattice on release, then persists. The
// pane stays modal — the scrim, one-at-a-time, and scroll-lock are unchanged; the
// only difference is the single pane's placement is now user-chosen and remembered.
// Vertical room (`maxHeight`) is derived from the drop position so the pane is
// always fully on-screen with a bottom gutter; content beyond that scrolls inside.
//
// Pane geometry — pure functions of the viewport, hoisted to module scope so the
// resize effect closes over nothing but `maxWidth` (genuinely exhaustive deps).
const widthFor = (maxWidth: number, vw: number) =>
  Math.min(maxWidth, vw - MARGIN * 2);
const maxXFor = (maxWidth: number, vw: number) =>
  Math.max(0, vw - widthFor(maxWidth, vw));
// Usable vertical room: the viewport less the fixed desktop nav row at its
// bottom (WORKSPACE-COLUMN-LAYOUT-ADR §VI) — the mirror of the fullScreen
// branch's MOBILE_BAR_H inset. The row is z-58, above the pane (z-56), so a
// pane that ignored it would slide underneath opaque chrome. Applied
// unconditionally on the desktop path: a member always lands in the workspace
// (HomeRedirect / WorkspacePaneRedirect), so a desktop pane over a rowless
// standalone page is only ever a transient pre-redirect frame.
const usableH = (vh: number) => Math.max(0, vh - NAV_ROW_H);
// Keep at least 120px of the pane (its draggable top + chrome) on-screen.
const maxYFor = (vh: number) => Math.max(0, usableH(vh) - 120);
const centreX = (maxWidth: number, vw: number) =>
  clampN(snap((vw - widthFor(maxWidth, vw)) / 2), 0, maxXFor(maxWidth, vw));

// Glasshouse only ever mounts client-side (on a user action, post-hydration), so
// measuring in the state initialiser is safe.
//
// When `resizable`, the pane also carries an explicit width/height the user sets
// via a bottom-right stretch handle (mirrors the vessel resize). Width overrides
// the centred default (anchored top-left, grows right); height switches the body
// from content-driven to a fixed box. Both snap to the lattice on release and
// persist per overlay. Either is always re-clamped to keep the pane on-screen.
function usePanePlacement(
  maxWidth: number,
  persistKey?: string,
  resizable?: boolean,
  fullScreen?: boolean,
) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState(() =>
    typeof window === "undefined"
      ? { vw: 1024, vh: 768 }
      : { vw: window.innerWidth, vh: window.innerHeight },
  );
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => {
    if (typeof window === "undefined" || !persistKey || !resizable) return null;
    return readSize(persistKey);
  });
  const [pos, setPos] = useState(() => {
    if (typeof window === "undefined") return { x: 0, y: MARGIN * 2 };
    const { innerWidth: vw, innerHeight: vh } = window;
    const stored = persistKey ? readPos(persistKey) : null;
    const base = stored ?? { x: centreX(maxWidth, vw), y: MARGIN * 2 };
    return {
      x: clampN(base.x, 0, maxXFor(maxWidth, vw)),
      y: clampN(base.y, 0, maxYFor(vh)),
    };
  });

  // Re-clamp to the viewport on resize so a remembered spot never strands the
  // pane off-screen on a smaller window.
  useEffect(() => {
    const onResize = () => {
      const { innerWidth: vw, innerHeight: vh } = window;
      setVp({ vw, vh });
      setPos((p) => ({
        x: clampN(p.x, 0, maxXFor(maxWidth, vw)),
        y: clampN(p.y, 0, maxYFor(vh)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [maxWidth]);

  // Active drag/resize listener teardown. Lives in a ref so (a) the unmount
  // effect below can detach listeners if the pane closes mid-gesture (Escape,
  // supersede) — otherwise the orphaned pointerup would setState on an
  // unmounted hook and persist a position for a closed pane — and (b) a new
  // gesture can defensively clear a previous one.
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      gestureCleanupRef.current?.();
      gestureCleanupRef.current = null;
    },
    [],
  );

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    gestureCleanupRef.current?.();
    const { innerWidth: vw, innerHeight: vh } = window;
    const offX = e.clientX - pos.x;
    const offY = e.clientY - pos.y;
    // Suppress text selection while the window rides the cursor (whole-pane drag
    // can start on a margin and sweep over prose). Restored on gesture teardown.
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onUp = (ev: PointerEvent) => {
      gestureCleanupRef.current?.();
      const dropped = {
        x: clampN(snap(ev.clientX - offX), 0, maxXFor(maxWidth, vw)),
        y: clampN(snap(ev.clientY - offY), 0, maxYFor(vh)),
      };
      setPos(dropped);
      if (persistKey) writePos(persistKey, dropped);
    };
    const onMove = (ev: PointerEvent) => {
      // Button released outside the window: no pointerup ever reaches us, so
      // the first buttonless move is the drop (else the pane rides the cursor
      // on re-entry until the next click).
      if ((ev.buttons & 1) === 0) {
        onUp(ev);
        return;
      }
      setPos({
        x: clampN(ev.clientX - offX, 0, maxXFor(maxWidth, vw)),
        y: clampN(ev.clientY - offY, 0, maxYFor(vh)),
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    gestureCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = prevUserSelect;
      gestureCleanupRef.current = null;
    };
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    gestureCleanupRef.current?.();
    const { innerWidth: vw, innerHeight: vh } = window;
    const startW = paneRef.current?.offsetWidth ?? widthFor(maxWidth, vw);
    const startH = paneRef.current?.offsetHeight ?? MIN_H;
    const { clientX: startX, clientY: startY } = e;
    // Cap so the stretched pane keeps a gutter to the right / bottom edge —
    // "bottom" being the top of the nav row, not the viewport floor.
    const maxW = Math.max(MIN_W, vw - pos.x - MARGIN);
    const maxH = Math.max(MIN_H, usableH(vh) - pos.y - MARGIN);
    const resolve = (ev: PointerEvent) => ({
      w: snap(clampN(startW + (ev.clientX - startX), MIN_W, maxW)),
      h: snap(clampN(startH + (ev.clientY - startY), MIN_H, maxH)),
    });
    const onUp = (ev: PointerEvent) => {
      gestureCleanupRef.current?.();
      const next = resolve(ev);
      setSize(next);
      if (persistKey) writeSize(persistKey, next);
    };
    const onMove = (ev: PointerEvent) => {
      if ((ev.buttons & 1) === 0) {
        onUp(ev);
        return;
      }
      setSize(resolve(ev));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    gestureCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      gestureCleanupRef.current = null;
    };
  };

  // Available on-screen height below the drop position; `--gh-h` and the pane's
  // own clamp both derive from it. Bounded above the nav row (usableH).
  const maxHeight = usableH(vp.vh) - pos.y - MARGIN;
  const effW = resizable
    ? clampN(size?.w ?? widthFor(maxWidth, vp.vw), MIN_W, Math.max(MIN_W, vp.vw - pos.x - MARGIN))
    : widthFor(maxWidth, vp.vw);
  // Explicit height only when resized vertically; otherwise content-driven (null).
  const effH = resizable && size?.h != null ? Math.min(size.h, maxHeight) : null;
  const ghH = effH ?? maxHeight;

  // Full-screen sheet (mobile): the pane fills the viewport BELOW the persistent
  // mobile top bar (MOBILE_BAR_H) — the bar is fixed chrome at z-58 that stays in
  // place across every view, so the sheet insets under it rather than hiding
  // behind it. Placement, drag and stretch are desktop pointer affordances and
  // don't apply here.
  if (fullScreen) {
    const h = Math.max(0, vp.vh - MOBILE_BAR_H);
    return {
      paneRef,
      x: 0,
      y: MOBILE_BAR_H,
      width: vp.vw,
      height: h,
      ghH: h,
      startDrag: null,
      startResize: null,
    };
  }

  return {
    paneRef,
    x: pos.x,
    y: pos.y,
    width: effW,
    height: effH,
    ghH,
    startDrag: startDrag as ((e: React.PointerEvent) => void) | null,
    startResize: resizable ? startResize : null,
  };
}

// The currently-open Glasshouse (or null). `token` is a per-instance identity so
// the unmount cleanup only clears the slot when it still owns it (never clobbers
// a successor that already claimed it).
let activeGlasshouse: { token: object; supersede: () => void } | null = null;

interface GlasshouseProps {
  /** Invoked by the scrim, the close button, and Escape. */
  onClose: () => void;
  /** State-only close used when this pane is superseded by a newer Glasshouse.
   *  Defaults to onClose; URL-synced callers (reader/profile/surface) pass their
   *  store's `dismiss` so superseding never triggers a history.back. */
  onSupersede?: () => void;
  /** Max width of the pane, in px. */
  maxWidth: number;
  /** Accessible label for the pane dialog. */
  ariaLabel?: string;
  /** Stable id for this surface; when set, the pane remembers its dragged spot
   *  (and, when resizable, its size) in localStorage between appearances. Omit to
   *  drag without persisting. */
  persistKey?: string;
  /** Add a bottom-right stretch handle so the pane can be resized (the writers).
   *  `maxWidth` then seeds the default width but no longer caps it. */
  resizable?: boolean;
  /** When this Glasshouse was launched from a specific feed (reader / profile
   *  opened off a card), the feed's WALLS colour (`palette.walls`, a
   *  `var(--ah-…)` string). The pane then frames itself with an INVERTED, thinner
   *  echo of that feed's vessel: a top bar + narrow side rules in that colour,
   *  open at the bottom — so the surface visibly belongs to the feed it came
   *  from. Omit for feed-agnostic surfaces. */
  frameColor?: string | null;
  /** Contrast tone for the skip-ear arrows on the frame (`palette.barText`).
   *  Falls back to bone when omitted. Only meaningful alongside `sideNav`. */
  frameTextColor?: string | null;
  /** Feed-skip "ears": half-circle tabs on the pane's left/right edges that step
   *  through the launching feed's articles in place (the reader's up/down skip).
   *  Rendered only when `frameColor` is set (the ears take its colour) and not
   *  on the mobile full-screen sheet. Omit for surfaces without feed navigation. */
  sideNav?: {
    onPrev: () => void;
    onNext: () => void;
    canPrev: boolean;
    canNext: boolean;
  } | null;
  /** This overlay manages its OWN browser history (it pushes a canonical URL and
   *  listens for popstate itself — the reader / profile / surface stores). Such
   *  overlays opt out of the built-in mobile back-guard, which would otherwise
   *  double-push a sentinel. Default false: the in-memory overlays (Messages,
   *  Dashboard, composers, …) rely on the guard so a mobile Back/edge-swipe
   *  closes the sheet instead of leaving the site. */
  selfHistory?: boolean;
  children: React.ReactNode;
}

export function Glasshouse({
  onClose,
  onSupersede,
  maxWidth,
  ariaLabel,
  persistKey,
  resizable,
  frameColor,
  frameTextColor,
  sideNav,
  selfHistory,
  children,
}: GlasshouseProps) {
  // On the mobile workspace (MOBILE-LAYOUT-ADR §III) every Glasshouse is a
  // full-screen sheet: same chrome, same one-at-a-time/Escape/scroll-lock
  // semantics, but the pane fills the viewport and drag/resize (pointer-
  // spatial affordances) don't render. Presentation only — callers are
  // untouched.
  const isMobile = useIsMobile();
  const pane = usePanePlacement(maxWidth, persistKey, resizable, isMobile);

  // Mobile back-guard: on the full-screen sheet, a browser Back / OS edge-swipe
  // should close this sheet (same as the disc-X), not leave the site. URL-synced
  // overlays manage their own history (`selfHistory`) and opt out. Desktop is
  // untouched — it has explicit ✕ affordances and no edge-swipe-back.
  useBackGuard(isMobile && !selfHistory, onClose);

  // Measured on-screen pane height — used only to vertically centre the skip
  // ears on the pane (its height is content-driven unless resized, so it can't
  // be derived from props). Tracks live as content / drag / resize change it.
  const [paneH, setPaneH] = useState(0);
  useEffect(() => {
    const el = pane.paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPaneH(el.offsetHeight));
    ro.observe(el);
    setPaneH(el.offsetHeight);
    return () => ro.disconnect();
  }, [pane.paneRef]);

  // The skip ears render only when the pane is framed (they take the frame
  // colour) and not on the mobile full-screen sheet (they'd fall off-screen).
  const showEars = !!frameColor && !!sideNav && !isMobile && paneH > 0;
  const earArrowColor = frameTextColor ?? "var(--ah-bone)";

  // While an Explain program is up, the pointer-events-none chrome (the frame
  // strips, a dimmed ear) is made hit-testable so its `data-explain` tags
  // resolve under the cursor — elementsFromPoint skips pointer-events:none
  // elements. Zero live-behaviour change: Explain's scrim (z-57 in pane mode)
  // intercepts every real pointer event for exactly the same window.
  const explainActive = useExplain((s) => s.isActive);

  // Whole-pane drag: grab the window by any empty/margin part of it. Bails on
  // interactive controls, selectable text, and scrollbar gutters (see
  // isDragSurface) so prose stays highlightable and controls stay live. The
  // explicit grip stays as a discoverable affordance. Disabled on the mobile
  // full-screen sheet (startDrag is null there).
  const onPanePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !pane.startDrag) return;
    const paneEl = pane.paneRef.current;
    if (!paneEl) return;
    if (!isDragSurface(e.target as Element, paneEl, e.clientX, e.clientY))
      return;
    pane.startDrag(e);
  };

  // Keep the supersede handler fresh (callers pass inline closures) without
  // re-running the register-on-mount effect.
  const tokenRef = useRef<object>({});
  const supersedeRef = useRef<() => void>(() => {});
  supersedeRef.current = onSupersede ?? onClose;
  // Kept fresh for the presence registry's `close()` (the disc-X minimise on
  // mobile) — the same close the pane's own ✕ and Escape fire.
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = onClose;

  // Register as the active Glasshouse on mount and supersede the prior one;
  // release the slot on unmount (only if we still hold it).
  useEffect(() => {
    const token = tokenRef.current;
    const prev = activeGlasshouse;
    activeGlasshouse = { token, supersede: () => supersedeRef.current() };
    if (prev && prev.token !== token) prev.supersede();
    // Mirror into the subscribable presence registry so the ∀ disc can act as the
    // minimise-X for this sheet (mobile). Token-guarded like the module var so a
    // superseded pane's unmount never clobbers its successor's slot.
    useGlasshousePresence.getState()._set(() => closeRef.current());
    return () => {
      if (activeGlasshouse && activeGlasshouse.token === token) {
        activeGlasshouse = null;
        useGlasshousePresence.getState()._set(null);
      }
    };
  }, []);

  // Escape closes; lock body scroll while the Glasshouse is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <>
      {/* Frosted scrim — full viewport, click to close. `.gh-scrim` (globals.css)
          blurs AND desaturates + washes the backdrop toward the mode's neutral
          ground, so the fixed parchment pane always meets the same field whatever
          per-feed scheme is behind (GLASSHOUSE-AND-PALETTE-ADR §III.1 — separation
          is the scrim's job, identity is the pane's). z-[55] sits above the
          workspace (so it blurs) but below the ForallMenu (z-60). */}
      <div className="fixed inset-0 z-[55] gh-scrim" onClick={onClose} />

      {/* Pane wrapper — click outside the pane closes. */}
      <div className="fixed inset-0 z-[56]" onClick={onClose}>
        <div
          ref={pane.paneRef}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          // The Explain engine's pane-mode root (EXPLAIN-ADR, D10 reversal
          // 2026-07-15): every Glasshouse is explainable as a pane, and this
          // tag answers any interior hover a more specific `data-explain` leaf
          // doesn't. Inert outside an active pane-mode Explain program.
          data-explain="pane"
          onPointerDown={onPanePointerDown}
          className="absolute bg-glasshouse shadow-lg overflow-hidden"
          // `--gh-h` is the on-screen height available to the body — it tracks the
          // drag position (and an explicit resized height), so each body sizes its
          // own scroll region against it (`max-h-[var(--gh-h)]` / `h-[var(--gh-h)]`)
          // instead of a fixed 100vh. The pane itself clips (overflow-hidden) so the
          // pinned chrome never scrolls; the body owns the scroll. `height` is set
          // only when the pane was stretched vertically; otherwise content-driven.
          style={
            {
              left: pane.x,
              top: pane.y,
              width: pane.width,
              height: pane.height ?? undefined,
              maxHeight: pane.ghH,
              "--gh-h": `${pane.ghH}px`,
            } as React.CSSProperties
          }
          onClick={(e) => e.stopPropagation()}
        >
          {/* Feed-launched frame — the inverted, thinner echo of the source
              feed's vessel (⊓: top bar + side rules, open at the bottom), in the
              feed's wall colour. A pointer-events-none colour overlay sitting in
              the content's top + side padding gutters, so it never disturbs the
              pane's width / scroll geometry. Below the chrome (z-10) so the grip
              and ✕ stay above the bar. Absent when frameColor is null. */}
          {frameColor && !isMobile && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-[5]"
            >
              <div
                data-explain="pane.frame"
                className="absolute left-0 right-0 top-0"
                style={{
                  height: FRAME_TOP,
                  background: frameColor,
                  pointerEvents: explainActive ? "auto" : undefined,
                }}
              />
              <div
                data-explain="pane.frame"
                className="absolute bottom-0 left-0 top-0"
                style={{
                  width: FRAME_SIDE,
                  background: frameColor,
                  pointerEvents: explainActive ? "auto" : undefined,
                }}
              />
              <div
                data-explain="pane.frame"
                className="absolute bottom-0 right-0 top-0"
                style={{
                  width: FRAME_SIDE,
                  background: frameColor,
                  pointerEvents: explainActive ? "auto" : undefined,
                }}
              />
            </div>
          )}
          {/* Drag handle — a grip pill, top-centre, pinned over the content.
              4px tall — a grip glyph, not a thin rule. Discoverable affordance
              for the whole-pane drag (the pane body drags too via
              onPanePointerDown). Absent on the mobile full-screen sheet. */}
          {pane.startDrag && (
            <div
              onPointerDown={pane.startDrag}
              role="button"
              aria-label="Drag to move"
              title="Drag to move"
              className="absolute left-1/2 top-3.5 z-10 h-1 w-9 -translate-x-1/2 rounded-full bg-grey-300 hover:bg-grey-600"
              style={{ cursor: "grab", touchAction: "none" }}
            />
          )}

          {/* Close — floats top-right over the pane content. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-4 z-10 text-grey-600 hover:text-black text-lg leading-none"
            style={{ background: "none", border: "none", cursor: "pointer" }}
          >
            ✕
          </button>

          {children}

          {/* Stretch handle — bottom-right corner, a 2px L-glyph (not a thin
              rule). Mirrors the vessel resize. Only on resizable panes. */}
          {pane.startResize && (
            <div
              role="button"
              aria-label="Resize"
              title="Drag to resize"
              data-explain="pane.resize"
              onPointerDown={pane.startResize}
              className="absolute z-10 text-grey-600"
              style={{
                right: 6,
                bottom: 4,
                width: 16,
                height: 16,
                cursor: "nwse-resize",
                touchAction: "none",
              }}
            >
              <span
                className="absolute block"
                style={{
                  right: 3,
                  bottom: 3,
                  width: 8,
                  height: 8,
                  borderRight: "2px solid currentColor",
                  borderBottom: "2px solid currentColor",
                  opacity: 0.6,
                }}
              />
            </div>
          )}
        </div>

        {/* Skip ears — half-circle tabs appended to the pane's left/right edges,
            each a triangular arrow that steps through the launching feed's
            articles in place. Siblings of the pane (not children), so they
            protrude past its overflow-hidden clip. Left = previous article (◀,
            up the feed); right = next article (▶, down the feed). The colour is
            the frame colour; a step that's unavailable dims its ear. */}
        {showEars && sideNav && (
          <>
            <button
              type="button"
              aria-label="Previous article"
              title="Previous article"
              data-explain="pane.ear.prev"
              disabled={!sideNav.canPrev}
              onClick={(e) => {
                e.stopPropagation();
                sideNav.onPrev();
              }}
              className="absolute z-10 flex items-center justify-center focus-ring"
              style={{
                left: pane.x - EAR_R,
                top: pane.y + paneH / 2 - EAR_R,
                width: EAR_R,
                height: EAR_R * 2,
                borderRadius: `${EAR_R}px 0 0 ${EAR_R}px`,
                background: frameColor ?? undefined,
                border: "none",
                cursor: sideNav.canPrev ? "pointer" : "default",
                opacity: sideNav.canPrev ? 1 : 0.3,
                // A dimmed ear passes clicks through to the wrapper (close);
                // during Explain it stays hit-testable so its label resolves.
                pointerEvents:
                  sideNav.canPrev || explainActive ? "auto" : "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 0,
                  height: 0,
                  borderTop: `${EAR_ARROW}px solid transparent`,
                  borderBottom: `${EAR_ARROW}px solid transparent`,
                  borderRight: `${EAR_ARROW}px solid ${earArrowColor}`,
                }}
              />
            </button>
            <button
              type="button"
              aria-label="Next article"
              title="Next article"
              data-explain="pane.ear.next"
              disabled={!sideNav.canNext}
              onClick={(e) => {
                e.stopPropagation();
                sideNav.onNext();
              }}
              className="absolute z-10 flex items-center justify-center focus-ring"
              style={{
                left: pane.x + pane.width,
                top: pane.y + paneH / 2 - EAR_R,
                width: EAR_R,
                height: EAR_R * 2,
                borderRadius: `0 ${EAR_R}px ${EAR_R}px 0`,
                background: frameColor ?? undefined,
                border: "none",
                cursor: sideNav.canNext ? "pointer" : "default",
                opacity: sideNav.canNext ? 1 : 0.3,
                pointerEvents:
                  sideNav.canNext || explainActive ? "auto" : "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 0,
                  height: 0,
                  borderTop: `${EAR_ARROW}px solid transparent`,
                  borderBottom: `${EAR_ARROW}px solid transparent`,
                  borderLeft: `${EAR_ARROW}px solid ${earArrowColor}`,
                }}
              />
            </button>
          </>
        )}
      </div>
    </>
  );
}
