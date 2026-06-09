"use client";

// =============================================================================
// Glasshouse — the canonical "frosted overlay over the workspace" primitive.
//
// One shape, reused everywhere a surface opens *over* the workspace (the reader
// pane, direct messages, future panels):
//   - a full-viewport frosted scrim (z-[55]) — a slight backdrop blur so the
//     workspace reads as frosted glass behind, click-to-close;
//   - a warm mid-light pane (z-[56], `bg-glasshouse`) lifted by an elevation
//     shadow alone (no top edge), click-through guarded. The pane is darker than
//     the light ground so it separates against bright feeds, lighter than the
//     dark ground so it separates in dark mode; fields inside it are the bright
//     wells. It opens snapped-centred on the 20px lattice and is DRAGGABLE by the
//     top-centre grip — drag is free, snaps to the lattice on release, clamps to
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

// Gutter between the pane and the viewport edge, on the 20px lattice.
const MARGIN = 20;

const clampN = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

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
// Keep at least 120px of the pane (its draggable top + chrome) on-screen.
const maxYFor = (vh: number) => Math.max(0, vh - 120);
const centreX = (maxWidth: number, vw: number) =>
  clampN(snap((vw - widthFor(maxWidth, vw)) / 2), 0, maxXFor(maxWidth, vw));

// Glasshouse only ever mounts client-side (on a user action, post-hydration), so
// measuring in the state initialiser is safe.
function usePanePlacement(maxWidth: number, persistKey?: string) {
  const [vp, setVp] = useState(() =>
    typeof window === "undefined"
      ? { vw: 1024, vh: 768 }
      : { vw: window.innerWidth, vh: window.innerHeight },
  );
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

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { innerWidth: vw, innerHeight: vh } = window;
    const offX = e.clientX - pos.x;
    const offY = e.clientY - pos.y;
    const onMove = (ev: PointerEvent) => {
      setPos({
        x: clampN(ev.clientX - offX, 0, maxXFor(maxWidth, vw)),
        y: clampN(ev.clientY - offY, 0, maxYFor(vh)),
      });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const dropped = {
        x: clampN(snap(ev.clientX - offX), 0, maxXFor(maxWidth, vw)),
        y: clampN(snap(ev.clientY - offY), 0, maxYFor(vh)),
      };
      setPos(dropped);
      if (persistKey) writePos(persistKey, dropped);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return {
    paneWidth: widthFor(maxWidth, vp.vw),
    x: pos.x,
    y: pos.y,
    maxHeight: vp.vh - pos.y - MARGIN,
    startDrag,
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
   *  in localStorage between appearances. Omit to drag without persisting. */
  persistKey?: string;
  children: React.ReactNode;
}

export function Glasshouse({
  onClose,
  onSupersede,
  maxWidth,
  ariaLabel,
  persistKey,
  children,
}: GlasshouseProps) {
  const pane = usePanePlacement(maxWidth, persistKey);

  // Keep the supersede handler fresh (callers pass inline closures) without
  // re-running the register-on-mount effect.
  const tokenRef = useRef<object>({});
  const supersedeRef = useRef<() => void>(() => {});
  supersedeRef.current = onSupersede ?? onClose;

  // Register as the active Glasshouse on mount and supersede the prior one;
  // release the slot on unmount (only if we still hold it).
  useEffect(() => {
    const token = tokenRef.current;
    const prev = activeGlasshouse;
    activeGlasshouse = { token, supersede: () => supersedeRef.current() };
    if (prev && prev.token !== token) prev.supersede();
    return () => {
      if (activeGlasshouse && activeGlasshouse.token === token) {
        activeGlasshouse = null;
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
      {/* Frosted scrim — full viewport, blur only (no tint, so the ground colour
          is preserved and the ForallMenu disc keeps its contrast), click to
          close. z-[55] sits above the workspace (so it blurs) but below the
          ForallMenu (z-60). */}
      <div
        className="fixed inset-0 z-[55] backdrop-blur-[3px]"
        onClick={onClose}
      />

      {/* Pane wrapper — click outside the pane closes. */}
      <div className="fixed inset-0 z-[56]" onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          className="absolute bg-glasshouse shadow-lg overflow-hidden"
          // `--gh-h` is the on-screen height available to the body — it tracks the
          // drag position, so each body sizes its own scroll region against it
          // (`max-h-[var(--gh-h)]` / `h-[var(--gh-h)]`) instead of a fixed 100vh.
          // The pane itself clips (overflow-hidden) so the pinned chrome never
          // scrolls; the body owns the scroll.
          style={
            {
              left: pane.x,
              top: pane.y,
              width: pane.paneWidth,
              maxHeight: pane.maxHeight,
              "--gh-h": `${pane.maxHeight}px`,
            } as React.CSSProperties
          }
          onClick={(e) => e.stopPropagation()}
        >
          {/* Drag handle — a grip pill, top-centre, pinned over the content.
              4px tall — a grip glyph, not a thin rule. Pointer-drags the pane. */}
          <div
            onPointerDown={pane.startDrag}
            role="button"
            aria-label="Drag to move"
            title="Drag to move"
            className="absolute left-1/2 top-2 z-10 h-1 w-9 -translate-x-1/2 rounded-full bg-grey-300 hover:bg-grey-600"
            style={{ cursor: "grab", touchAction: "none" }}
          />

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
        </div>
      </div>
    </>
  );
}
