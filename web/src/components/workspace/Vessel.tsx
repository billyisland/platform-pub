'use client'

import type { ReactNode } from 'react'

// Vessel — the ⊔ chassis, per WIREFRAME-DECISIONS-CONSOLIDATED.md Step 1.
//
// Slice 1: static. No drag, resize, rotate, brightness, or density controls.
// Tokens are inline (medium-bright defaults from Step 1 / "Colour tokens
// committed") rather than added to tailwind.config.js — they are local to the
// experiment and shouldn't pollute global tokens until the shape settles.

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
}

export function Vessel({ name, children, onNameClick }: VesselProps) {
  return (
    <div style={{ width: WIDTH }} role="region" aria-label={name}>
      {/* Name label sits above the opening. Click opens the feed composer
          (slice 4); long-press lives in the gesture system not yet built. */}
      {onNameClick ? (
        <button
          type="button"
          onClick={onNameClick}
          className="font-mono uppercase tracking-[0.06em] text-[11px] mb-2 px-1 text-left"
          style={{
            color: TOKENS.nameLabel,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {name}
        </button>
      ) : (
        <div
          className="font-mono uppercase tracking-[0.06em] text-[11px] mb-2 px-1"
          style={{ color: TOKENS.nameLabel }}
        >
          {name}
        </div>
      )}

      {/* The ⊔: left wall + right wall + base. Opening = full width at top. */}
      <div
        style={{
          // Left + right + bottom walls drawn via borders.
          borderLeft: `${WALL}px solid ${TOKENS.walls}`,
          borderRight: `${WALL}px solid ${TOKENS.walls}`,
          borderBottom: `${WALL}px solid ${TOKENS.walls}`,
          background: TOKENS.interior,
          padding: `${PAD}px`,
          // Cards stack vertically with GAP between them.
          display: 'flex',
          flexDirection: 'column',
          gap: `${GAP}px`,
        }}
      >
        {children}
      </div>
    </div>
  )
}
