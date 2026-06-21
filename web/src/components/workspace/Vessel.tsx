"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  motion,
  animate,
  useDragControls,
  useMotionValue,
} from "framer-motion";
import { prefersReducedMotion } from "../../lib/workspace/motion";
import { snap, GRID } from "../../lib/workspace/grid";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";
import {
  paletteFor,
  DEFAULT_DENSITY,
  DEFAULT_ORIENTATION,
  type Brightness,
  type Density,
  type Orientation,
} from "./tokens";
import { VesselBar, BAR_H } from "./VesselBar";
import { PullToRefresh } from "./PullToRefresh";

// Vessel — the ⊔ chassis, per WIREFRAME-DECISIONS-CONSOLIDATED.md Step 1.
//
// Slice 5a: drag-to-position via the name label as drag handle.
// Slice 5b: resize via bottom-right corner handle.
// Slice 5c: brightness / density / orientation. Brightness drives a
// resolved palette across walls, interior, name label, and (via prop) the
// cards inside. Density flows to cards. Orientation toggles the chassis
// between vertical (⊔: left + right + bottom walls) and horizontal
// (⊏: top + left + bottom walls, opening on the right) — cards lay out
// in a row when horizontal, with horizontal scroll when h or w is set.
//
// The three controls live as small cycle buttons on the chassis bottom-right
// edge (alongside the resize handle). Per ADR §5 the touch gestures
// (two-finger vertical drag for brightness, two-finger rotation for
// orientation, gestural density toggle) are deferred; the cycle buttons are
// the desktop alternative for now.

// Side-wall thickness. Exported so overlays launched from a feed (the reader /
// profile Glasshouse) can frame themselves at the SAME thickness as the feed's
// vessel wall — the frame echoes the container the surface came from.
export const WALL = 8; // px
const PAD = 16; // px interior padding (top zone left open per Step 1: "Opening: full width of the vessel interior")
const GAP = 12; // px inter-card gap
const WIDTH = 300; // px default at standard density

const ROUNDEL_TOKENS = {
  bg: "var(--ah-ink-925)",
  fg: "var(--ah-bone)",
};

// Slice 5b: minimums per spec ("below which content becomes illegible").
// Spec says no maximum; we clamp at sane upper bounds defensively — the
// floor's overflow:hidden handles oversize visually, and a workspace-level
// reset returns truly-lost vessels.
const MIN_W = 220;
const MIN_H = 200;
const MAX_W = 2000;
const MAX_H = 2000;

interface VesselProps {
  children: ReactNode;
  feedId: string;
  numeral: number;
  descriptiveName?: string;
  onNameClick?: () => void;
  onSourceAdded?: () => void;
  position: { x: number; y: number };
  size?: { w?: number; h?: number };
  brightness?: Brightness;
  density?: Density;
  orientation?: Orientation;
  hidden?: boolean;
  onHide?: () => void;
  onPositionCommit: (pos: { x: number; y: number }) => void;
  onSizeCommit?: (size: { w: number; h: number }) => void;
  onDragStart?: () => void;
  onDragFrame?: (pos: { x: number; y: number }) => void;
  dragConstraints?: RefObject<HTMLElement>;
  onCardDrop?: (data: string) => void;
  onRefresh?: () => Promise<void>;
  /** Infinite scroll: called when the scroll body nears its end so the host can
   *  append the next (older) page. The host guards against concurrent/exhausted
   *  loads. */
  onLoadMore?: (feedId: string) => void;
  caughtUp?: boolean;
  onCaughtUpDismiss?: () => void;
}

export function Vessel({
  children,
  feedId,
  numeral,
  descriptiveName,
  onNameClick,
  onSourceAdded,
  position,
  size,
  brightness,
  density,
  orientation,
  hidden,
  onHide,
  onPositionCommit,
  onSizeCommit,
  onDragStart: onDragStartProp,
  onDragFrame,
  dragConstraints,
  onCardDrop,
  onRefresh,
  onLoadMore,
  caughtUp,
  onCaughtUpDismiss,
}: VesselProps) {
  const dragControls = useDragControls();
  const [isDragTarget, setIsDragTarget] = useState(false);
  const vesselRef = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(position.x);
  const my = useMotionValue(position.y);
  const dragMovedRef = useRef(false);
  const [roundelHovered, setRoundelHovered] = useState(false);
  const [liveSize, setLiveSize] = useState<{ w: number; h: number } | null>(
    null,
  );
  const resizeStateRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    maxW: number;
    maxH: number;
  } | null>(null);

  const effDensity = density ?? DEFAULT_DENSITY;
  const effOrientation = orientation ?? DEFAULT_ORIENTATION;
  const palette = paletteFor(brightness);
  const isHorizontal = effOrientation === "horizontal";

  const isDraggingRef = useRef(false);
  const prevScrollTopRef = useRef(0);

  useEffect(() => {
    if (!caughtUp || !onCaughtUpDismiss) return;
    const el = scrollBodyRef.current;
    if (!el) return;
    prevScrollTopRef.current = el.scrollTop;
    function onScroll() {
      if (!el) return;
      if (el.scrollTop < prevScrollTopRef.current) {
        onCaughtUpDismiss!();
      }
      prevScrollTopRef.current = el.scrollTop;
    }
    function onWheel(e: WheelEvent) {
      if (!el) return;
      if (el.scrollTop === 0 && e.deltaY < 0) {
        onCaughtUpDismiss!();
      }
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [caughtUp, onCaughtUpDismiss]);

  // Infinite scroll: fire onLoadMore when the scroll position nears the end so
  // older content keeps flowing in. The threshold (a card-or-two ahead of the
  // edge) makes the load feel seamless. Fires on the active axis only.
  useEffect(() => {
    if (!onLoadMore) return;
    const el = scrollBodyRef.current;
    if (!el) return;
    const THRESHOLD = 320;
    function onScroll() {
      if (!el) return;
      const nearEnd = isHorizontal
        ? el.scrollWidth - el.scrollLeft - el.clientWidth < THRESHOLD
        : el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
      if (nearEnd) onLoadMore!(feedId);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [onLoadMore, feedId, isHorizontal]);

  useEffect(() => {
    if (isDraggingRef.current) return;
    const dx = Math.abs(mx.get() - position.x);
    const dy = Math.abs(my.get() - position.y);
    if ((dx > 1 || dy > 1) && !prefersReducedMotion()) {
      animate(mx, position.x, {
        type: "spring",
        stiffness: 600,
        damping: 40,
        mass: 0.6,
      });
      animate(my, position.y, {
        type: "spring",
        stiffness: 600,
        damping: 40,
        mass: 0.6,
      });
    } else {
      mx.set(position.x);
      my.set(position.y);
    }
  }, [position.x, position.y, mx, my]);

  function startDrag(event: React.PointerEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, [role='button']"))
      return;
    dragMovedRef.current = false;
    dragControls.start(event);
  }

  function clampPos(x: number, y: number) {
    const floor = dragConstraints?.current;
    const vessel = vesselRef.current;
    if (!floor || !vessel) return { x, y };
    const maxX = Math.max(
      0,
      Math.floor((floor.clientWidth - vessel.offsetWidth) / GRID) * GRID,
    );
    const maxY = Math.max(
      0,
      Math.floor((floor.clientHeight - vessel.offsetHeight) / GRID) * GRID,
    );
    return {
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    };
  }

  // Effective dimensions: liveSize during a resize gesture wins; otherwise
  // committed size from props; otherwise intrinsic defaults.
  const effW = liveSize?.w ?? size?.w ?? WIDTH;
  const effH = liveSize?.h ?? size?.h; // undefined = intrinsic content height
  const heightSet = effH !== undefined;

  function handleResizePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!onSizeCommit) return;
    event.preventDefault();
    event.stopPropagation();
    const startW = effW;
    const chassisEl = vesselRef.current?.querySelector(
      "[data-vessel-chassis]",
    ) as HTMLElement | null;
    const startH = effH ?? chassisEl?.getBoundingClientRect().height ?? MIN_H;
    let maxW = MAX_W;
    let maxH = MAX_H;
    const floor = dragConstraints?.current;
    const vessel = vesselRef.current;
    if (floor && vessel) {
      const overhead = vessel.offsetHeight - startH;
      maxW = Math.max(
        MIN_W,
        Math.min(
          MAX_W,
          Math.floor((floor.clientWidth - mx.get()) / GRID) * GRID,
        ),
      );
      maxH = Math.max(
        MIN_H,
        Math.min(
          MAX_H,
          Math.floor((floor.clientHeight - my.get() - overhead) / GRID) * GRID,
        ),
      );
    }
    resizeStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startW,
      startH,
      maxW,
      maxH,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setLiveSize({ w: startW, h: startH });
  }

  function handleResizePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = resizeStateRef.current;
    if (!state) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    const w = snap(Math.max(MIN_W, Math.min(state.maxW, state.startW + dx)));
    const h = snap(Math.max(MIN_H, Math.min(state.maxH, state.startH + dy)));
    setLiveSize({ w, h });
  }

  function handleResizePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const state = resizeStateRef.current;
    resizeStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released if the gesture was cancelled.
    }
    if (!state || !liveSize || !onSizeCommit) {
      setLiveSize(null);
      return;
    }
    onSizeCommit({ w: liveSize.w, h: liveSize.h });
    setLiveSize(null);
  }

  function handleChassisDragOver(e: React.DragEvent) {
    if (!onCardDrop) return;
    if (!e.dataTransfer.types.includes("application/x-vessel-card")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!isDragTarget) setIsDragTarget(true);
  }

  function handleChassisDragLeave(e: React.DragEvent) {
    const chassis = e.currentTarget as HTMLElement;
    if (chassis.contains(e.relatedTarget as Node)) return;
    setIsDragTarget(false);
  }

  function handleChassisDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragTarget(false);
    const raw = e.dataTransfer.getData("application/x-vessel-card");
    if (!raw || !onCardDrop) return;
    onCardDrop(raw);
  }

  // Wall arrangement per orientation. The bottom wall is replaced by VesselBar,
  // so only left/right (vertical) or top/left (horizontal) get thin borders.
  const wallStyle = isHorizontal
    ? {
        borderTop: `${WALL}px solid ${palette.walls}`,
        borderLeft: `${WALL}px solid ${palette.walls}`,
      }
    : {
        borderLeft: `${WALL}px solid ${palette.walls}`,
        borderRight: `${WALL}px solid ${palette.walls}`,
      };

  return (
    <motion.div
      ref={vesselRef}
      data-vessel-id={feedId}
      role="region"
      aria-label={
        descriptiveName
          ? `Feed ${numeral}: ${descriptiveName}`
          : `Feed ${numeral}`
      }
      drag
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={dragConstraints}
      dragMomentum={false}
      dragElastic={0}
      onPointerDown={startDrag}
      onDragStart={() => {
        isDraggingRef.current = true;
        onDragStartProp?.();
      }}
      onDrag={(_, info) => {
        if (info.offset.x !== 0 || info.offset.y !== 0)
          dragMovedRef.current = true;
        const clamped = clampPos(snap(mx.get()), snap(my.get()));
        mx.set(clamped.x);
        my.set(clamped.y);
        onDragFrame?.({ x: clamped.x, y: clamped.y });
      }}
      onDragEnd={() => {
        isDraggingRef.current = false;
        onPositionCommit(clampPos(snap(mx.get()), snap(my.get())));
      }}
      style={{
        // Light island: desktop vessels keep their per-scheme colours
        // regardless of the global light/dark mode (web/src/lib/palette/island.ts).
        ...LIGHT_ISLAND_STYLE,
        position: "absolute",
        x: mx,
        y: my,
        width: effW,
        touchAction: "none",
        cursor: hidden ? undefined : "grab",
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? "none" : undefined,
      }}
    >
      {/* The vessel chassis. Position relative so chrome controls (resize +
          brightness / density / orientation) can pin to its corners. When the
          user has fixed a height, the body becomes a scroll container;
          otherwise it grows with content. */}
      <div
        data-vessel-chassis
        onDragOver={handleChassisDragOver}
        onDragLeave={handleChassisDragLeave}
        onDrop={handleChassisDrop}
        style={{
          position: "relative",
          ...wallStyle,
          background: palette.interior,
          height: heightSet ? effH : undefined,
          display: "flex",
          flexDirection: "column",
          outline: isDragTarget ? `2px solid ${palette.walls}` : undefined,
          outlineOffset: -2,
        }}
      >
        {/* Feed numeral — bottom-left corner */}
        <div
          onMouseEnter={() => setRoundelHovered(true)}
          onMouseLeave={() => setRoundelHovered(false)}
          onDoubleClick={() => onNameClick?.()}
          className="select-none font-sans"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            width: BAR_H,
            height: BAR_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ah-white)",
            fontSize: 22,
            fontWeight: 600,
            lineHeight: 1,
            cursor: "grab",
            zIndex: 6,
          }}
        >
          {numeral}
          {descriptiveName && (
            <div
              className="label-ui"
              style={{
                position: "absolute",
                left: 0,
                bottom: "100%",
                marginBottom: 4,
                background: ROUNDEL_TOKENS.bg,
                color: ROUNDEL_TOKENS.fg,
                padding: "3px 8px",
                whiteSpace: "nowrap",
                boxShadow: "0 2px 6px rgba(0, 0, 0, 0.15)",
                opacity: roundelHovered ? 1 : 0,
                pointerEvents: "none",
                transition: "opacity 120ms ease-out",
              }}
            >
              {descriptiveName}
            </div>
          )}
        </div>

        <div
          ref={scrollBodyRef}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            padding: `${PAD}px`,
            flex: heightSet ? "1 1 0" : undefined,
            minHeight: 0,
            overflowY: heightSet && !isHorizontal ? "auto" : undefined,
            overflowX: isHorizontal ? "auto" : undefined,
            cursor: "default",
          }}
        >
          {/* The gap lives on the element that actually contains the cards, not
              on the scroll body (whose only direct child is PullToRefresh). */}
          {onRefresh ? (
            <PullToRefresh onRefresh={onRefresh} scrollRef={scrollBodyRef}>
              <div
                style={{
                  display: "flex",
                  flexDirection: isHorizontal ? "row" : "column",
                  gap: `${GAP}px`,
                }}
              >
                {children}
              </div>
            </PullToRefresh>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: isHorizontal ? "row" : "column",
                gap: `${GAP}px`,
              }}
            >
              {children}
            </div>
          )}
        </div>

        {/* VesselBar replaces the bottom wall — gear + hide + source input.
            Appearance controls moved into the FeedComposer modal (task 8). */}
        <VesselBar
          feedId={feedId}
          palette={palette}
          onSourceAdded={onSourceAdded}
          onNameClick={onNameClick}
          onHide={onHide}
        />

        {onSizeCommit && (
          <div
            role="button"
            aria-label="Resize vessel"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
            style={{
              position: "absolute",
              right: isHorizontal ? 0 : -WALL,
              bottom: 0,
              width: 16,
              height: 16,
              cursor: "nwse-resize",
              touchAction: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                right: 3,
                bottom: 3,
                width: 8,
                height: 8,
                borderRight: `2px solid ${palette.barTextMuted}`,
                borderBottom: `2px solid ${palette.barTextMuted}`,
                opacity: 0.7,
              }}
            />
          </div>
        )}
      </div>
    </motion.div>
  );
}
