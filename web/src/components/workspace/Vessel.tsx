'use client'

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { motion, useDragControls, useMotionValue } from 'framer-motion'

// Vessel — the ⊔ chassis, per WIREFRAME-DECISIONS-CONSOLIDATED.md Step 1.
//
// Slice 5a: drag-to-position via the name label as drag handle. The vessel
// owns no layout state — position is driven by props and committed back via
// onPositionCommit. Resize, rotate, brightness, density still deferred.
// Tokens stay inline (medium-bright defaults from "Colour tokens committed")
// rather than added to tailwind.config.js — they are local to the experiment
// and shouldn't pollute global tokens until the shape settles.

const TOKENS = {
  walls: '#4A4A47',
  interior: '#E6E5E0',
  nameLabel: '#8A8880',
}

const WALL = 8 // px
const PAD = 16 // px interior padding (top zone left open per Step 1: "Opening: full width of the vessel interior")
const GAP = 12 // px inter-card gap
const WIDTH = 300 // px default at standard density

interface VesselProps {
  name: string
  children: ReactNode
  onNameClick?: () => void
  position: { x: number; y: number }
  onPositionCommit: (pos: { x: number; y: number }) => void
  dragConstraints?: RefObject<HTMLElement>
}

export function Vessel({
  name,
  children,
  onNameClick,
  position,
  onPositionCommit,
  dragConstraints,
}: VesselProps) {
  const dragControls = useDragControls()
  const mx = useMotionValue(position.x)
  const my = useMotionValue(position.y)
  const dragMovedRef = useRef(false)

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
        width: WIDTH,
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
            color: TOKENS.nameLabel,
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
          style={{ color: TOKENS.nameLabel, cursor: 'grab' }}
        >
          {name}
        </div>
      )}

      {/* The ⊔: left wall + right wall + base. Opening = full width at top. */}
      <div
        style={{
          borderLeft: `${WALL}px solid ${TOKENS.walls}`,
          borderRight: `${WALL}px solid ${TOKENS.walls}`,
          borderBottom: `${WALL}px solid ${TOKENS.walls}`,
          background: TOKENS.interior,
          padding: `${PAD}px`,
          display: 'flex',
          flexDirection: 'column',
          gap: `${GAP}px`,
        }}
      >
        {children}
      </div>
    </motion.div>
  )
}
