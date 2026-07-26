'use client'

import { useState, type CSSProperties } from 'react'
import Image from 'next/image'
import { paletteFor } from '../workspace/tokens'
import { LIGHT_ISLAND_STYLE } from '../../lib/palette/island'
import { useResolvedDark } from '../../stores/colorScheme'
import { ForallDisc } from '../brand/ForallDisc'

// =============================================================================
// LandingVessel — `/`'s chassis. An ABSTRACTION of the workspace vessel, not a
// picture of one.
//
// IT FILLS THE SCREEN AND SCROLLS INSIDE, like a workspace feed. The vessel is
// sized to the app-shell column (page.tsx: a `100dvh` flex column, vessel area
// above, nav row below) via `flex: 1; minHeight: 0`, so it is always fully
// visible on screen — walls, mouth and bottom all in frame — and the CARD
// COLUMN scrolls within it (the innermost `overflowY: auto` region, the same
// `flex:1 / minHeight:0 / overflowY:auto` body Vessel.tsx scrolls). There is no
// document scroll on `/` at all, which is what killed the mobile rubber-band:
// the shell is pinned to the viewport and only the card column moves.
//
// WHAT IT DELIBERATELY OMITS. A feed vessel carries a numeral in the reserved
// bottom-left square, a descriptive-name roundel, and a 32px VesselBar that
// REPLACES the bottom wall. All three are gone here, on purpose: they say "feed
// n of m", which is a claim the landing page cannot make — there are no feeds
// on it and the visitor has no account to hold any. What survives is the part
// that is actually the house style: the ⊔ stance, the 8px wall, the 8px
// lattice, square corners, cards on a continuous ground that scroll as a column.
//
// SO THE BOTTOM IS A PLAIN WALL. The live workspace never shows that shape —
// there the bar always occupies the bottom edge. This is the abstraction, not a
// stale render: do NOT "fix" it by reinstating VesselBar. If the landing page
// ever needs a control down there, it wants a new thing, not the feed's.
//
// THE DOUBLED WALL (the one addition), ON DESKTOP. Wall, one GRID of interior,
// wall — so the lattice reads as even stripes at the page's own edge, which is
// the reading WORKSPACE-DESIGN-SPEC asks the grid square to have (grid square ≈
// wall thickness, so wall/buffer/wall stripes evenly). A visitor meets the
// measure before they ever meet a feed. Both frames open at the top: the mouth
// is the arrival end, and closing it would make this a box rather than a vessel.
// Both frames clip (`overflow: hidden`) so the scrolling column reads as feed
// cards passing behind a fixed mouth, exactly as a workspace vessel does.
//
// ON MOBILE THE VESSEL GOES FULL-BLEED and the doubled wall collapses to a
// single one — the floor margin, the outer wall and its buffer all drop, and the
// interior pad halves. A phone cannot afford 56px a side to argue about an 8px
// square, and the mobile workspace drops the vessel chassis outright for a
// full-bleed feed, so this is the same instinct one notch softer. THE GEOMETRY
// FOR BOTH FORM FACTORS LIVES IN globals.css §1c (`.ah-landing-area`,
// `.ah-landing-frame*`), not in this file: `/` is SSR'd, so a JS breakpoint
// would paint the desktop chassis on a phone and snap after hydration. Change
// wall thickness or padding THERE. What stays here is the palette-derived wall
// colour, handed to the CSS as `--ah-landing-wall`.
//
// NO CALL TO ACTION IN HERE. The waiting-list button lives once, in the nav
// row, where it is on screen for the whole page rather than only at the foot of
// it. A second copy at the end of the prose said the same words to the same
// destination — on a page this short that reads as nagging, not as closing the
// argument. If it ever comes back it belongs in a card of its own, not tacked
// onto the bottom of the prose card.
//
// THE SCROLL EARNS ITS KEEP: sell text, then a SHOWCASE of live-site
// screengrabs (LandingShot — each a framed figure with a caption), then a
// closing CODA (the ∀ disc + the motto ‘FOR ALL’, centred) that ends the
// column. The screengrabs are real <img>s pointed at `/landing/*` in
// web/public, and the FRAME takes ITS ratio from THEM (see SHOT_RATIO below);
// if one ever goes missing the frame shows a faint disc placeholder instead
// (LandingShot's onError), so the slot reads as intentional rather than as a
// broken image. The coda is the one place the disc appears inside the vessel.
//
// THE PROPOSITIONS ARE A REAL <ol>. They are literally three numbered
// propositions, so the list is the ordered list, not div-soup with a decorative
// numeral — a screen reader announces "list, 3 items" and the count. The <ol>
// is one flex child of the scroll column with the same GAP as its siblings; the
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

const GAP = 12 // inter-card gap

// The shot frame's aspect ratio, and it is the SHOTS' OWN ratio, not a chosen
// one: every screengrab is a full 1848×1056 viewport capture, so the frame is
// cut to fit them rather than the other way round. That is what makes the
// `objectFit: cover` below a no-op — nothing is padded to fit the frame and
// nothing is cropped away by it. If the shots are ever recaptured at another
// size, change this number to match; do not letterbox the images into it.
const SHOT_RATIO = '1848 / 1056'

export interface Shot {
  /** Path under web/public, e.g. `/landing/workspace.webp`. */
  src: string
  alt: string
  caption: string
}

interface LandingVesselProps {
  headline: string
  propositions: string[]
  prose: string[]
  shots: Shot[]
}

// A single screengrab card body: a framed figure at the shots' own ratio, with a
// caption. Until the image at `shot.src` exists it falls back to a faint disc
// placeholder, so the slot always looks deliberate and never shows a
// broken-image glyph.
function LandingShot({
  shot,
  frameBg,
  captionColor,
}: {
  shot: Shot
  frameBg: string
  captionColor: string
}) {
  const [failed, setFailed] = useState(false)

  return (
    <figure style={{ margin: 0 }}>
      <div
        style={{
          position: 'relative',
          aspectRatio: SHOT_RATIO,
          background: frameBg,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {failed ? (
          <span style={{ opacity: 0.22 }}>
            <ForallDisc size={56} />
          </span>
        ) : (
          <Image
            src={shot.src}
            alt={shot.alt}
            fill
            sizes="(max-width: 760px) 100vw, 680px"
            onError={() => setFailed(true)}
            style={{ objectFit: 'cover' }}
          />
        )}
      </div>
      <figcaption
        className="label-ui"
        style={{ color: captionColor, marginTop: 10 }}
      >
        {shot.caption}
      </figcaption>
    </figure>
  )
}

export function LandingVessel({
  headline,
  propositions,
  prose,
  shots,
}: LandingVesselProps) {
  const globalDark = useResolvedDark()
  const palette = paletteFor('basic', globalDark)

  // A ⊔ frame that fills its flex parent and clips its overflow. Both frames use
  // it — outer and inner. The WALL THICKNESS AND PADDING ARE NOT HERE: they are
  // `.ah-landing-frame*` in globals.css, because mobile collapses the doubled
  // wall to a single one and only a media query can do that without a
  // post-hydration snap on this SSR'd page (see the CSS comment). What stays
  // inline is what CSS cannot know: the palette-derived wall colour, handed over
  // as `--ah-landing-wall`, and the interior.
  const frame = {
    background: palette.interior,
    flex: 1,
    minHeight: 0,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    overflow: 'hidden' as const,
  }

  const card = {
    background: palette.cardBg,
    padding: '18px 20px',
  }

  return (
    <div
      className="ah-landing-frame ah-landing-frame-outer"
      style={
        {
          ...LIGHT_ISLAND_STYLE,
          ...frame,
          '--ah-landing-wall': palette.walls,
        } as CSSProperties
      }
    >
      <div
        className="ah-landing-frame ah-landing-frame-inner"
        style={frame}
      >
        {/* The scrolling card column — the one moving part. `.scroll-silent`
            hides the native scrollbar (whose track would draw a banned vertical
            rule); wheel / touch / keyboard scroll are unaffected. */}
        <div
          className="scroll-silent"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
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

          {shots.map((shot, i) => (
            <div key={`shot-${i}`} style={card}>
              <LandingShot
                shot={shot}
                frameBg={palette.interior}
                captionColor={palette.cardStandfirst}
              />
            </div>
          ))}

          {/* Closing coda — the mark, then the motto. Ends the scroll. Its own
              padding (not the shared `card` spread) so it can breathe as a
              finale. */}
          <div
            style={{
              background: palette.cardBg,
              padding: '40px 20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 18,
            }}
          >
            <ForallDisc size={64} />
            <span
              className="font-mono"
              style={{
                color: palette.cardStandfirst,
                fontSize: 13,
                letterSpacing: '0.2em',
              }}
            >
              ‘FOR ALL’
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
