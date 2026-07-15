"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  useExplain,
  type Annotation,
  type HoverTarget,
} from "../../stores/explain";
import { useExplainRegistry } from "./ExplainProvider";
import { type ExplainKind, explainCopy } from "../../lib/explain/registry";
import { prefersReducedMotion } from "../../lib/workspace/motion";
import { useGlasshousePresence } from "../../stores/glasshouse";

// =============================================================================
// ExplainOverlay — the visible engine layer (EXPLAIN-ADR §5, D1, D9, D11, D12).
//
// Slice 4 replaces the stub bubble with the real renderer: viewport-clamped
// placement (right → left → below → above), a 2px crimson leader with a 4px dot
// at the target end, live `getBoundingClientRect` measurement re-run on a
// ResizeObserver (floor container + the pinned target's own vessel scroll
// container, D11), drag suspension (D11 seam), and a reduced-motion path
// (opacity only, no leader draw). Still inert in production until the ∀-menu row
// (slice 5) opens a program.
//
// D1 — the floor is inert while active: the scrim is a single full-viewport div
// that intercepts ALL pointer events (wheel/touch included), so the frozen floor
// cannot scroll and the surface is annotated exactly as it stood at open().
//   - pointermove → coordinate hit-test → live hover (D4).
//   - click on a discoverable target → pin it; click anywhere else → dismiss.
// Hit-test sources (D1): (a) `[data-explain]` tagged leaves via elementsFromPoint
// → closest, and (b) the registration Map's live root rects (floor / vessel /
// disc) by element identity.
// =============================================================================

// Marks the overlay's own DOM so hit-testing looks straight through it.
const CHROME_ATTR = "data-explain-chrome";

const BUBBLE_WIDTH = 300; // fixed width → predictable placement; height adapts
const GAP = 14; // target edge → bubble gap
const MARGIN = 10; // viewport margin the bubble keeps clear
const ENTER_MS = 200; // opacity / leader-draw enter duration

interface ResolvedTarget extends HoverTarget {
  el: HTMLElement;
}

export function ExplainOverlay() {
  const registry = useExplainRegistry();
  const isActive = useExplain((s) => s.isActive);
  const annotations = useExplain((s) => s.annotations);
  const index = useExplain((s) => s.index);
  const hover = useExplain((s) => s.hover);
  const dragging = useExplain((s) => s.draggingFeedId != null);
  const programKind = useExplain((s) => s.program?.kind);
  const setHover = useExplain((s) => s.setHover);
  const pin = useExplain((s) => s.pin);
  const next = useExplain((s) => s.next);
  const prev = useExplain((s) => s.prev);
  const close = useExplain((s) => s.close);

  const reduced = prefersReducedMotion();

  // Bumped by the ResizeObserver / window-resize so bubbles re-measure their
  // live target rect (D11). The floor is frozen (D1), so there is no scroll
  // trigger — only reflow (vessel add/remove/resize, async interior growth).
  const [measureTick, setMeasureTick] = useState(0);

  // Resolve the pointer to the most specific explainable target under it.
  // elementsFromPoint returns deepest-painted first, so a tagged leaf (a
  // descendant of its vessel root) is always found before the root — giving
  // leaf > vessel > floor precedence for free.
  const hitTest = useCallback(
    (x: number, y: number): ResolvedTarget | null => {
      if (typeof document === "undefined") return null;
      const roots = registry?.snapshot() ?? [];
      const vessels = roots.filter((r) => r.kind === "vessel");
      const stack = document.elementsFromPoint(x, y) as HTMLElement[];
      for (const el of stack) {
        // Skip our own scrim / bubbles — look through them to the floor.
        if (el.closest(`[${CHROME_ATTR}]`)) continue;
        const tagged = el.closest<HTMLElement>("[data-explain]");
        if (tagged) {
          const kind = tagged.getAttribute("data-explain") as ExplainKind;
          // vessel.* leaves belong to a vessel; card.* leaves carry no key.
          const key = kind.startsWith("vessel.")
            ? vessels.find((v) => v.ref.current?.contains(tagged))?.key
            : undefined;
          return { kind, key, el: tagged };
        }
        // A registered root (floor / vessel / disc) — identity match.
        const root = roots.find((r) => r.ref.current === el);
        if (root) {
          return {
            kind: root.kind,
            key: root.kind === "vessel" ? root.key : undefined,
            el,
          };
        }
      }
      return null;
    },
    [registry],
  );

  // Resolve an annotation's live DOM element for measurement (D11). Roots come
  // from the registry Map; leaves are queried, vessel.* scoped to their vessel.
  const elementFor = useCallback(
    (t: HoverTarget): HTMLElement | null => {
      if (typeof document === "undefined") return null;
      const roots = registry?.snapshot() ?? [];
      if (t.kind === "floor" || t.kind === "disc") {
        return roots.find((r) => r.kind === t.kind)?.ref.current ?? null;
      }
      if (t.kind === "vessel") {
        return (
          roots.find((r) => r.kind === "vessel" && r.key === t.key)?.ref
            .current ?? null
        );
      }
      if (t.kind.startsWith("vessel.") && t.key) {
        const v = roots.find((r) => r.kind === "vessel" && r.key === t.key)?.ref
          .current;
        return (
          v?.querySelector<HTMLElement>(`[data-explain="${t.kind}"]`) ?? null
        );
      }
      // Card kinds carry no key: the representative sequential annotation (D5)
      // anchors to the topmost such leaf in the lowest-sort_rank vessel that has
      // it (DOM order within a vessel is top-to-bottom). A pinned hover-only
      // card would carry a key, but non-representative cards aren't measured by
      // instance here — the pin path mints them without a distinct anchor, so
      // any live leaf of the kind is the correct target.
      if (t.kind.startsWith("card")) {
        const vessels = roots
          .filter((r) => r.kind === "vessel")
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        for (const v of vessels) {
          const el = v.ref.current?.querySelector<HTMLElement>(
            `[data-explain="${t.kind}"]`,
          );
          if (el) return el;
        }
        return null;
      }
      return document.querySelector<HTMLElement>(`[data-explain="${t.kind}"]`);
    },
    [registry],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (useExplain.getState().draggingFeedId) return; // suppress hover mid-drag
      const hit = hitTest(e.clientX, e.clientY);
      const cur = useExplain.getState().hover;
      const next: HoverTarget | null = hit
        ? { kind: hit.kind, key: hit.key }
        : null;
      const changed =
        (cur?.kind ?? null) !== (next?.kind ?? null) ||
        (cur?.key ?? undefined) !== (next?.key ?? undefined);
      if (changed) setHover(next);
    },
    [hitTest, setHover],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        pin({ kind: hit.kind, key: hit.key }); // D1 click-pin
      } else {
        close(); // D1 empty-click dismiss
      }
    },
    [hitTest, pin, close],
  );

  // Copy for a live hover target, folding the vessel provenance fork (D7): read
  // fromStarter off the anchored vessel's registration params.
  const copyForHover = useCallback(
    (t: HoverTarget): string => {
      if (t.kind === "vessel") {
        const roots = registry?.snapshot() ?? [];
        const v = roots.find((r) => r.kind === "vessel" && r.key === t.key);
        return explainCopy("vessel", !!v?.params?.fromStarter);
      }
      return explainCopy(t.kind);
    },
    [registry],
  );

  const pinned: Annotation | null = annotations[index] ?? null;
  const pinnedEl = pinned ? elementFor(pinned) : null;

  // D11 re-measure: observe the floor container (vessel add/remove/resize) and,
  // while a target is pinned, that target's own vessel scroll container (async
  // ingestion can reflow the interior under the pinned card, a shift the floor
  // observer misses). No `scroll` trigger — the floor is frozen (D1).
  useEffect(() => {
    if (!isActive || typeof ResizeObserver === "undefined") return;
    const bump = () => setMeasureTick((t) => t + 1);
    const ro = new ResizeObserver(bump);
    const floor = registry
      ?.snapshot()
      .find((r) => r.kind === "floor")?.ref.current;
    if (floor) ro.observe(floor);
    const vesselScroll = pinnedEl?.closest<HTMLElement>("[data-vessel-scroll]");
    if (vesselScroll) ro.observe(vesselScroll);
    window.addEventListener("resize", bump);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", bump);
    };
  }, [isActive, registry, pinnedEl]);

  // Esc precedence (D12): open Glasshouse → Explain → ForallMenu dropdown. One
  // capture-phase handler early-returns while the About pane is open (its own
  // Escape handler consumes it, Glasshouse.tsx), otherwise closes Explain and
  // stops propagation so the ForallMenu dropdown's Esc never also fires.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (useGlasshousePresence.getState().isOpen) return;
        e.stopPropagation();
        close();
        return;
      }
      // First-run arrow stepping (the sequence's free-floating beats can't be
      // clicked to advance). Ignored while typing in a field.
      if (useExplain.getState().program?.kind !== "firstrun") return;
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        useExplain.getState().next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        useExplain.getState().prev();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isActive, close]);

  if (!isActive) return null;

  const hoverAnn: Annotation | null =
    hover && !dragging
      ? { kind: hover.kind, key: hover.key, copy: copyForHover(hover) }
      : null;

  return (
    <>
      {/* Scrim — z-50, flat wash ≤0.18 alpha, no backdrop-filter (D9): feeds
          stay legible behind their own labels. Catches every pointer event so
          the floor is frozen (D1). */}
      <div
        {...{ [CHROME_ATTR]: "" }}
        onPointerMove={handlePointerMove}
        onClick={handleClick}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 50,
          background: "rgb(var(--ah-true-black-rgb) / 0.14)",
          cursor: "default",
        }}
      />
      {/* Pinned bubble — suspended (hidden) while a vessel is dragged (D11). */}
      {pinned && !dragging && (
        <Bubble
          key={`pin:${pinned.kind}:${pinned.key ?? ""}`}
          annotation={pinned}
          el={pinnedEl}
          dimmed={!!hoverAnn}
          reduced={reduced}
          measureTick={measureTick}
          stepper={
            programKind === "firstrun"
              ? {
                  index,
                  total: annotations.length,
                  done: !!pinned.done,
                  onPrev: prev,
                  onNext: next,
                  onDone: close,
                }
              : null
          }
        />
      )}
      {hoverAnn && (
        <Bubble
          key={`hover:${hoverAnn.kind}:${hoverAnn.key ?? ""}`}
          annotation={hoverAnn}
          el={elementFor(hoverAnn)}
          reduced={reduced}
          hover
          measureTick={measureTick}
        />
      )}
    </>
  );
}

// -----------------------------------------------------------------------------
// Bubble — measures the live target rect, places itself in the side with most
// free room (right → left → below → above, clamped to the viewport), and draws
// a 2px crimson leader from the target edge midpoint to the bubble edge with a
// 4px dot at the target end (D11). A free-float annotation (floor/disc beats, or
// a target whose element has deregistered) centres over the floor with no
// leader (D8).
// -----------------------------------------------------------------------------

type Side = "right" | "left" | "below" | "above";

interface Placement {
  left: number;
  top: number;
  bw: number;
  bh: number;
  side: Side | null; // null → free-float, no leader
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

function placeBubble(rect: DOMRect | null, size: { w: number; h: number }): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = size.w || BUBBLE_WIDTH;
  const bh = size.h || 120;

  if (!rect) {
    // Free-float: centred horizontally, upper-middle of the floor (D8).
    return {
      left: clamp(vw / 2 - bw / 2, MARGIN, vw - bw - MARGIN),
      top: clamp(vh * 0.4 - bh / 2, MARGIN, vh - bh - MARGIN),
      bw,
      bh,
      side: null,
    };
  }

  const sideTop = clamp(
    rect.top + rect.height / 2 - bh / 2,
    MARGIN,
    Math.max(MARGIN, vh - bh - MARGIN),
  );
  const stackLeft = clamp(
    rect.left + rect.width / 2 - bw / 2,
    MARGIN,
    Math.max(MARGIN, vw - bw - MARGIN),
  );

  const candidates: { side: Side; free: number; fits: boolean; left: number; top: number }[] = [
    {
      side: "right",
      free: vw - rect.right - GAP,
      fits: vw - rect.right - GAP >= bw + MARGIN,
      left: rect.right + GAP,
      top: sideTop,
    },
    {
      side: "left",
      free: rect.left - GAP,
      fits: rect.left - GAP >= bw + MARGIN,
      left: rect.left - GAP - bw,
      top: sideTop,
    },
    {
      side: "below",
      free: vh - rect.bottom - GAP,
      fits: vh - rect.bottom - GAP >= bh + MARGIN,
      left: stackLeft,
      top: rect.bottom + GAP,
    },
    {
      side: "above",
      free: rect.top - GAP,
      fits: rect.top - GAP >= bh + MARGIN,
      left: stackLeft,
      top: rect.top - GAP - bh,
    },
  ];

  const pick =
    candidates.find((c) => c.fits) ??
    candidates.reduce((a, b) => (b.free > a.free ? b : a));

  return {
    left: clamp(pick.left, MARGIN, Math.max(MARGIN, vw - bw - MARGIN)),
    top: clamp(pick.top, MARGIN, Math.max(MARGIN, vh - bh - MARGIN)),
    bw,
    bh,
    side: pick.side,
  };
}

// Leader endpoints: from the target's facing-edge midpoint to the bubble's
// near-edge midpoint. The dot sits at the target end (x1, y1).
function leaderPoints(
  side: Side,
  rect: DOMRect,
  p: Placement,
): { x1: number; y1: number; x2: number; y2: number } {
  const tcx = rect.left + rect.width / 2;
  const tcy = rect.top + rect.height / 2;
  switch (side) {
    case "right":
      return { x1: rect.right, y1: tcy, x2: p.left, y2: p.top + p.bh / 2 };
    case "left":
      return { x1: rect.left, y1: tcy, x2: p.left + p.bw, y2: p.top + p.bh / 2 };
    case "below":
      return { x1: tcx, y1: rect.bottom, x2: p.left + p.bw / 2, y2: p.top };
    case "above":
      return { x1: tcx, y1: rect.top, x2: p.left + p.bw / 2, y2: p.top + p.bh };
  }
}

// The first-run stepping controls carried in the pinned bubble (§6, D12). The
// free-floating floor beats can't be clicked to advance, so the sequence needs
// explicit Back / Next, and beat 6 needs the "done" affordance.
interface Stepper {
  index: number;
  total: number;
  done: boolean;
  onPrev: () => void;
  onNext: () => void;
  onDone: () => void;
}

function Bubble({
  annotation,
  el,
  dimmed,
  hover,
  reduced,
  stepper,
}: {
  annotation: Annotation;
  el: HTMLElement | null;
  dimmed?: boolean;
  hover?: boolean;
  reduced: boolean;
  // First-run only, pinned bubble only (§6). Null for Explain + hover bubbles.
  stepper?: Stepper | null;
  // Re-render trigger: the overlay bumps it on reflow so the target rect below
  // is re-read. Not consumed directly — its identity change forces this render.
  measureTick: number;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({
    w: BUBBLE_WIDTH,
    h: 120,
  });
  const [shown, setShown] = useState(false);

  // Measure own box each render; converges (only sets on change) so no loop.
  useLayoutEffect(() => {
    const node = bubbleRef.current;
    if (!node) return;
    const r = node.getBoundingClientRect();
    setSize((prev) =>
      prev.w === r.width && prev.h === r.height
        ? prev
        : { w: r.width, h: r.height },
    );
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Live rect, re-read every render (the overlay re-renders on reflow, D11).
  const rect =
    annotation.alwaysFloat || !el ? null : el.getBoundingClientRect();
  const place = placeBubble(rect, size);

  const copy = annotation.copy || `[${annotation.kind}]`;
  const opacity = shown ? (dimmed ? 0.35 : 1) : 0;

  const leader =
    rect && place.side ? leaderPoints(place.side, rect, place) : null;
  const leaderLen = leader
    ? Math.hypot(leader.x2 - leader.x1, leader.y2 - leader.y1)
    : 0;
  // Reduced motion: static leader (offset 0), opacity-only enter. Otherwise the
  // leader draws from the target toward the bubble.
  const leaderOffset = reduced ? 0 : shown ? 0 : leaderLen;

  return (
    <>
      {leader && (
        <svg
          {...{ [CHROME_ATTR]: "" }}
          width="100%"
          height="100%"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 51,
            pointerEvents: "none",
            overflow: "visible",
            opacity,
            transition: reduced ? undefined : `opacity ${ENTER_MS}ms ease-out`,
          }}
        >
          <line
            x1={leader.x1}
            y1={leader.y1}
            x2={leader.x2}
            y2={leader.y2}
            strokeWidth={2}
            strokeDasharray={leaderLen}
            strokeDashoffset={leaderOffset}
            style={{
              stroke: "var(--ah-crimson)",
              transition: reduced
                ? undefined
                : `stroke-dashoffset ${ENTER_MS}ms ease-out`,
            }}
          />
          <circle
            cx={leader.x1}
            cy={leader.y1}
            r={2}
            style={{ fill: "var(--ah-crimson)" }}
          />
        </svg>
      )}
      <div
        {...{ [CHROME_ATTR]: "" }}
        ref={bubbleRef}
        className="bg-glasshouse text-black shadow-lg whitespace-pre-line"
        style={{
          position: "fixed",
          left: place.left,
          top: place.top,
          width: BUBBLE_WIDTH,
          zIndex: hover ? 53 : 52,
          padding: "14px 16px",
          borderRadius: 10,
          fontSize: "14px",
          lineHeight: 1.5,
          pointerEvents: "none",
          opacity,
          transition: reduced ? undefined : `opacity ${ENTER_MS}ms ease-out`,
        }}
      >
        {copy}
        {stepper && (
          // pointerEvents:auto so the controls are clickable through the
          // otherwise inert bubble; whitespace (marginTop, never a rule)
          // separates them from the copy.
          <div
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginTop: 16,
            }}
          >
            <span className="label-ui text-grey-400">
              {stepper.index + 1} / {stepper.total}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              {stepper.index > 0 && (
                <button
                  type="button"
                  className="btn-text-muted"
                  onClick={stepper.onPrev}
                >
                  Back
                </button>
              )}
              {stepper.done ? (
                <button
                  type="button"
                  className="btn-text"
                  onClick={stepper.onDone}
                >
                  Done
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-text"
                  onClick={stepper.onNext}
                >
                  Next
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
