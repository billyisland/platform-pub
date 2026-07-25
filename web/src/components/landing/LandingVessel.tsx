'use client'

import { paletteFor } from '../workspace/tokens'
import { LIGHT_ISLAND_STYLE } from '../../lib/palette/island'
import { useResolvedDark } from '../../stores/colorScheme'

// =============================================================================
// LandingVessel — `/`'s chassis. An ABSTRACTION of the workspace vessel, not a
// picture of one.
//
// WHAT IT DELIBERATELY OMITS. A feed vessel carries a numeral in the reserved
// bottom-left square, a descriptive-name roundel, and a 32px VesselBar that
// REPLACES the bottom wall. All three are gone here, on purpose: they say "feed
// n of m", which is a claim the landing page cannot make — there are no feeds
// on it and the visitor has no account to hold any. What survives is the part
// that is actually the house style: the ⊔ stance, the 8px wall, the 8px
// lattice, square corners, cards on a continuous ground.
//
// SO THE BOTTOM IS A PLAIN WALL. The live workspace never shows that shape —
// there the bar always occupies the bottom edge. This is the abstraction, not a
// stale render: do NOT "fix" it by reinstating VesselBar. If the landing page
// ever needs a control down there, it wants a new thing, not the feed's.
//
// THE DOUBLED WALL (the one addition). Wall, one GRID of interior, wall — so
// the lattice reads as even stripes at the page's own edge, which is the
// reading WORKSPACE-DESIGN-SPEC asks the grid square to have (grid square ≈
// wall thickness, so wall/buffer/wall stripes evenly). A visitor meets the
// measure before they ever meet a feed. Both frames open at the top: the mouth
// is the arrival end, and closing it would make this a box rather than a vessel.
//
// NO CALL TO ACTION IN HERE. The waiting-list button lives once, in the nav
// row, where it is on screen for the whole page rather than only at the foot of
// it. A second copy at the end of the prose said the same words to the same
// destination — on a page this short that reads as nagging, not as closing the
// argument. If it ever comes back it belongs in a card of its own, not tacked
// onto the bottom of the prose card.
//
// THE PROPOSITIONS ARE A REAL <ol>. They are literally three numbered
// propositions, so the list is the ordered list, not div-soup with a decorative
// numeral — a screen reader announces "list, 3 items" and the count. The <ol>
// is one flex child of the interior with the same GAP as its siblings and its
// own internal GAP between <li> cards, so every card gap stays uniform; the
// crimson numeral is presentational (the <li> position already carries order).
//
// COLOUR. `basic` follows the global light/dark toggle — that is the whole
// point of the neutral colourway, and unlike a seasonal scheme it has nothing
// to preserve against it. So the palette is resolved with the resolved dark flag
// exactly as Vessel.tsx resolves its own, and LIGHT_ISLAND_STYLE then pins the
// derived neutral slugs so BASIC_DARK's explicit values aren't inverted a second
// time by html.dark. Copy the pair or neither; the island alone would freeze the
// page light, the flag alone would double-invert it. The flag is useResolvedDark
// (the DOM class the pre-paint script set), not the store's lagging `dark`, so a
// dark-mode visitor never paints the light vessel on the dark floor first.
// =============================================================================

const WALL = 8 // side-wall thickness (Vessel.tsx)
const PAD = 16 // interior padding
const GAP = 12 // inter-card gap
const GRID = 8 // the workspace lattice square — here, the wall buffer

interface LandingVesselProps {
  headline: string
  propositions: string[]
  prose: string[]
}

export function LandingVessel({
  headline,
  propositions,
  prose,
}: LandingVesselProps) {
  const globalDark = useResolvedDark()
  const palette = paletteFor('basic', globalDark)

  const wallStyle = {
    borderLeft: `${WALL}px solid ${palette.walls}`,
    borderRight: `${WALL}px solid ${palette.walls}`,
    borderBottom: `${WALL}px solid ${palette.walls}`,
  }

  const card = {
    background: palette.cardBg,
    padding: '18px 20px',
  }

  return (
    <div
      style={{
        ...LIGHT_ISLAND_STYLE,
        ...wallStyle,
        background: palette.interior,
        padding: GRID,
      }}
    >
      <div
        style={{
          ...wallStyle,
          background: palette.interior,
          padding: PAD,
          display: 'flex',
          flexDirection: 'column',
          gap: GAP,
        }}
      >
        <div style={card}>
          <h1
            className="font-serif font-medium tracking-tight"
            style={{
              fontSize: 30,
              lineHeight: 1.2,
              color: palette.cardTitle,
              margin: 0,
            }}
          >
            {headline}
          </h1>
        </div>

        <ol
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: GAP,
            listStyle: 'none',
            margin: 0,
            padding: 0,
          }}
        >
          {propositions.map((proposition, i) => (
            <li key={i} style={card}>
              <div style={{ display: 'flex', gap: 16 }}>
                <span
                  aria-hidden="true"
                  className="font-mono text-mono-sm"
                  style={{ color: palette.crimson, paddingTop: 3 }}
                >
                  {i + 1}
                </span>
                <span
                  className="font-serif"
                  style={{
                    fontSize: 22,
                    lineHeight: 1.4,
                    color: palette.cardTitle,
                  }}
                >
                  {proposition}
                </span>
              </div>
            </li>
          ))}
        </ol>

        <div style={card}>
          <div
            className="font-mono"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              fontSize: '1.0625rem',
              lineHeight: 1.65,
              letterSpacing: '0.01em',
              color: palette.cardStandfirst,
            }}
          >
            {prose.map((para, i) => (
              <p key={i} style={{ margin: 0 }}>
                {para}
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
