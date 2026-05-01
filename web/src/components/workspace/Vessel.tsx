'use client'

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { motion, useDragControls, useMotionValue } from 'framer-motion'
import {
  PALETTES,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  DEFAULT_ORIENTATION,
  nextBrightness,
  nextDensity,
  nextOrientation,
  type Brightness,
  type Density,
  type Orientation,
} from './tokens'

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

const WALL = 8 // px
const PAD = 16 // px interior padding (top zone left open per Step 1: "Opening: full width of the vessel interior")
const GAP = 12 // px inter-card gap
const WIDTH = 300 // px default at standard density

// Slice 5b: minimums per spec ("below which content becomes illegible").
// Spec says no maximum; we clamp at sane upper bounds defensively — the
// floor's overflow:hidden handles oversize visually, and a workspace-level
// reset returns truly-lost vessels.
const MIN_W = 220
const MIN_H = 200
const MAX_W = 2000
const MAX_H = 2000

interface VesselProps {
  name: string
  children: ReactNode
  onNameClick?: () => void
  position: { x: number; y: number }
  size?: { w?: number; h?: number }
  brightness?: Brightness
  density?: Density
  orientation?: Orientation
  onPositionCommit: (pos: { x: number; y: number }) => void
  onSizeCommit?: (size: { w: number; h: number }) => void
  onBrightnessCommit?: (b: Brightness) => void
  onDensityCommit?: (d: Density) => void
  onOrientationCommit?: (o: Orientation) => void
  dragConstraints?: RefObject<HTMLElement>
}

export function Vessel({
  name,
  children,
  onNameClick,
  position,
  size,
  brightness,
  density,
  orientation,
  onPositionCommit,
  onSizeCommit,
  onBrightnessCommit,
  onDensityCommit,
  onOrientationCommit,
  dragConstraints,
}: VesselProps) {
  const dragControls = useDragControls()
  const mx = useMotionValue(position.x)
  const my = useMotionValue(position.y)
  const dragMovedRef = useRef(false)
  const [liveSize, setLiveSize] = useState<{ w: number; h: number } | null>(null)
  const resizeStateRef = useRef<{
    startX: number
    startY: number
    startW: number
    startH: number
  } | null>(null)

  const effBrightness = brightness ?? DEFAULT_BRIGHTNESS
  const effDensity = density ?? DEFAULT_DENSITY
  const effOrientation = orientation ?? DEFAULT_ORIENTATION
  const palette = PALETTES[effBrightness]
  const isHorizontal = effOrientation === 'horizontal'

  // Mirror externally-driven position changes (hydrate, programmatic move)
  // back into the motion values so the next drag starts from the right place.
  useEffect(() => {
    mx.set(position.x)
    my.set(position.y)
  }, [position.x, position.y, mx, my])

  function startDrag(event: React.PointerEvent) {
    dragMovedRef.current = false
    dragControls.start(event)
  }

  function handleNameClick() {
    // Suppress the click that fires at the end of a drag — we treat any
    // pointer movement during the gesture as "this was a drag, not a click."
    if (dragMovedRef.current) return
    onNameClick?.()
  }

  // Effective dimensions: liveSize during a resize gesture wins; otherwise
  // committed size from props; otherwise intrinsic defaults.
  const effW = liveSize?.w ?? size?.w ?? WIDTH
  const effH = liveSize?.h ?? size?.h // undefined = intrinsic content height
  const heightSet = effH !== undefined

  function handleResizePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!onSizeCommit) return
    event.preventDefault()
    event.stopPropagation()
    const startW = effW
    // Measure current rendered height so the first drag pixel doesn't snap
    // to whatever value the cards happen to compute to.
    const chassis = (event.currentTarget.parentElement?.querySelector('[data-vessel-chassis]') ??
      null) as HTMLElement | null
    const startH = effH ?? chassis?.getBoundingClientRect().height ?? MIN_H
    resizeStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startW,
      startH,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setLiveSize({ w: startW, h: startH })
  }

  function handleResizePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = resizeStateRef.current
    if (!state) return
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    const w = Math.max(MIN_W, Math.min(MAX_W, state.startW + dx))
    const h = Math.max(MIN_H, Math.min(MAX_H, state.startH + dy))
    setLiveSize({ w, h })
  }

  function handleResizePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const state = resizeStateRef.current
    resizeStateRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released if the gesture was cancelled.
    }
    if (!state || !liveSize || !onSizeCommit) {
      setLiveSize(null)
      return
    }
    onSizeCommit({ w: liveSize.w, h: liveSize.h })
    setLiveSize(null)
  }

  // Wall arrangement per orientation:
  //   vertical   → ⊔ : left + right + bottom (opening on top)
  //   horizontal → ⊏ : top + left + bottom    (opening on right)
  const wallStyle = isHorizontal
    ? {
        borderTop: `${WALL}px solid ${palette.walls}`,
        borderLeft: `${WALL}px solid ${palette.walls}`,
        borderBottom: `${WALL}px solid ${palette.walls}`,
      }
    : {
        borderLeft: `${WALL}px solid ${palette.walls}`,
        borderRight: `${WALL}px solid ${palette.walls}`,
        borderBottom: `${WALL}px solid ${palette.walls}`,
      }

  const brightnessGlyph: Record<Brightness, string> = {
    primary: '○',
    medium: '◐',
    dim: '●',
  }
  const densityGlyph: Record<Density, string> = {
    compact: 'c',
    standard: 's',
    full: 'f',
  }
  const orientationGlyph: Record<Orientation, string> = {
    vertical: '|',
    horizontal: '─',
  }

  return (
    <motion.div
      role="region"
      aria-label={name}
      drag
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={dragConstraints}
      dragMomentum={false}
      dragElastic={0}
      onDrag={(_, info) => {
        if (info.offset.x !== 0 || info.offset.y !== 0) dragMovedRef.current = true
      }}
      onDragEnd={() => {
        onPositionCommit({ x: mx.get(), y: my.get() })
      }}
      style={{
        position: 'absolute',
        x: mx,
        y: my,
        width: effW,
        touchAction: 'none',
      }}
    >
      {/* Name label sits above the opening, doubles as drag handle. Click
          opens the feed composer (slice 4); pointerDown initiates drag. */}
      {onNameClick ? (
        <button
          type="button"
          onPointerDown={startDrag}
          onClick={handleNameClick}
          className="font-mono uppercase tracking-[0.06em] text-[11px] mb-2 px-1 text-left select-none"
          style={{
            color: palette.nameLabel,
            background: 'transparent',
            border: 'none',
            cursor: 'grab',
            padding: 0,
          }}
        >
          {name}
        </button>
      ) : (
        <div
          onPointerDown={startDrag}
          className="font-mono uppercase tracking-[0.06em] text-[11px] mb-2 px-1 select-none"
          style={{ color: palette.nameLabel, cursor: 'grab' }}
        >
          {name}
        </div>
      )}

      {/* The vessel chassis. Position relative so chrome controls (resize +
          brightness / density / orientation) can pin to its corners. When the
          user has fixed a height, the body becomes a scroll container;
          otherwise it grows with content. */}
      <div
        data-vessel-chassis
        style={{
          position: 'relative',
          ...wallStyle,
          background: palette.interior,
          height: heightSet ? effH : undefined,
        }}
      >
        <div
          style={{
            padding: `${PAD}px`,
            display: 'flex',
            flexDirection: isHorizontal ? 'row' : 'column',
            gap: `${GAP}px`,
            height: heightSet ? '100%' : undefined,
            overflowY: heightSet && !isHorizontal ? 'auto' : undefined,
            overflowX: isHorizontal ? 'auto' : undefined,
          }}
        >
          {children}
        </div>

        {/* Cycle controls: brightness · density · orientation. Pinned to the
            chassis bottom-right edge, just left of the resize handle. Each is
            a small mono-glyph that cycles state on click. Hover tooltip
            (title=) carries the full label so the abbreviations are
            discoverable. */}
        {(onBrightnessCommit || onDensityCommit || onOrientationCommit) && (
          <div
            style={{
              position: 'absolute',
              right: 22,
              bottom: -WALL - 18,
              display: 'flex',
              gap: 4,
              alignItems: 'center',
            }}
          >
            {onBrightnessCommit && (
              <CycleButton
                label={`Brightness: ${effBrightness}`}
                glyph={brightnessGlyph[effBrightness]}
                color={palette.resizeHandle}
                onClick={() => onBrightnessCommit(nextBrightness(effBrightness))}
              />
            )}
            {onDensityCommit && (
              <CycleButton
                label={`Density: ${effDensity}`}
                glyph={densityGlyph[effDensity]}
                color={palette.resizeHandle}
                onClick={() => onDensityCommit(nextDensity(effDensity))}
              />
            )}
            {onOrientationCommit && (
              <CycleButton
                label={`Orientation: ${effOrientation}`}
                glyph={orientationGlyph[effOrientation]}
                color={palette.resizeHandle}
                onClick={() => onOrientationCommit(nextOrientation(effOrientation))}
              />
            )}
          </div>
        )}

        {onSizeCommit && (
          <div
            role="button"
            aria-label="Resize vessel"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
            style={{
              position: 'absolute',
              right: -WALL,
              bottom: -WALL,
              width: 16,
              height: 16,
              cursor: 'nwse-resize',
              touchAction: 'none',
            }}
          >
            {/* Tiny corner mark — present but quiet, like a piece of furniture
                with a hint of grain at the corner. */}
            <div
              style={{
                position: 'absolute',
                right: 3,
                bottom: 3,
                width: 8,
                height: 8,
                borderRight: `2px solid ${palette.resizeHandle}`,
                borderBottom: `2px solid ${palette.resizeHandle}`,
                opacity: 0.7,
              }}
            />
          </div>
        )}
      </div>
    </motion.div>
  )
}

function CycleButton({
  label,
  glyph,
  color,
  onClick,
}: {
  label: string
  glyph: string
  color: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="font-mono uppercase tracking-[0.06em] text-[11px] select-none"
      style={{
        color,
        background: 'transparent',
        border: 'none',
        padding: '0 4px',
        cursor: 'pointer',
        opacity: 0.75,
        lineHeight: 1,
      }}
    >
      {glyph}
    </button>
  )
}
