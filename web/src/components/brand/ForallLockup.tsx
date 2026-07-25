'use client'

import Link from 'next/link'
import { useResolvedDark } from '../../stores/colorScheme'

// =============================================================================
// ForallLockup — the STATIC lockup (wordmark + ∀ disc, adjacent) for surfaces
// that need the mark but not the menu.
//
// `ForallMenu anchor="row"` is the member lockup: it carries the workspace
// menu, the ∀↔X morph, the hover spin, the unread badge and the Explain
// chrome-swap. A logged-out visitor has no workspace to navigate, so mounting
// it on `/` would ship ~950 lines of menu for a mark. This component renders
// the same two things in the same relationship and nothing else.
//
// GEOMETRY IS THE DISC FORM'S, NOT THE BARE GLYPH'S
// (FORALL-CUT-AND-LOCKUP-ADR §III.1, as resolved 2026-07-22). Both ends pin to
// the rim — feet overshooting so the circle trims them flush through the top,
// apex mitring to a point that kisses the bottom — which forces the ≈16.7°
// splay. Do NOT substitute `ForAllMark` here: that is the bare glyph at the
// canonical ~20.5°, correct for Nav/Footer/About where there is no rim to kiss
// and wrong the moment you put a disc behind it.
//
// PAINT, NOT PUNCH (§II). The ∀ is drawn in the ground colour over an opaque
// disc rather than masked through it. On a flat known ground the two are
// pixel-identical, and the landing floor is flat — there is nothing behind the
// mark worth glimpsing, so the punch buys nothing and costs a mask.
//
// The disc inverts under `html.dark` exactly as ForallMenu's does (dark bone
// disc / ink glyph): the row it sits on is `--ah-bone`, a neutral slug, so it
// follows the global toggle. It reads the mode via useResolvedDark (not the
// store's lagging `dark` field) so a dark-mode visitor never paints the light
// disc first — the reason this is a client component.
// =============================================================================

const CLIP_ID = 'ah-lockup-clip'

interface ForallLockupProps {
  /** Rendered disc diameter. 40 is the nav-row size; 40 + 2·GRID = NAV_ROW_H. */
  discSize?: number
  /** Wordmark size. 24 with a 40 disc holds §V's disc/cap-height ≈ 2.3. */
  wordmarkSize?: number
  href?: string
}

export function ForallLockup({
  discSize = 40,
  wordmarkSize = 24,
  href = '/',
}: ForallLockupProps) {
  const dark = useResolvedDark()
  const discBg = dark ? 'var(--ah-bone)' : 'var(--ah-ink-925)'
  const discGlyph = dark ? 'var(--ah-ink-925)' : 'var(--ah-bone)'

  return (
    <Link
      href={href}
      aria-label="all.haus home"
      style={{
        display: 'flex',
        alignItems: 'center',
        // §V's 14px wordmark↔disc gap. Drop to 12 only if the pair reads loose.
        gap: 14,
        flexShrink: 0,
      }}
    >
      {/* Wordmark set to the LEFT of the disc so the two read as one mark
          (text · glyph). It matches the disc's GROUND, not its glyph — ink on
          the light row, bone on the inverted one. */}
      <span
        className="font-sans font-medium leading-none"
        style={{
          fontSize: wordmarkSize,
          color: discBg,
          letterSpacing: '-0.01em',
        }}
      >
        all.haus
      </span>

      {/* Wrapper clips in the RENDERED coordinate space; the inner clipPath
          clips in the scaled one. Both are needed — the feet overshoot the top
          circumference by construction, and either clip alone leaks a sliver at
          some DPR. */}
      <span
        aria-hidden="true"
        style={{
          position: 'relative',
          display: 'block',
          width: discSize,
          height: discSize,
          borderRadius: '50%',
          overflow: 'hidden',
          background: discBg,
          flexShrink: 0,
        }}
      >
        <svg viewBox="0 0 56 56" width={discSize} height={discSize}>
          <defs>
            {/* r=28 is the LITERAL rim, not a hair-inset: under the cut geometry
                the feet meet the rim flush and the apex kisses it, so a 1-unit
                inset would leave the ink slice §III.1 exists to avoid. */}
            <clipPath id={CLIP_ID}>
              <circle cx="28" cy="28" r="28" />
            </clipPath>
          </defs>
          <g
            clipPath={`url(#${CLIP_ID})`}
            style={{ stroke: discGlyph }}
            strokeWidth={5.06}
            strokeLinecap="butt"
            fill="none"
          >
            {/* One path so the interior apex miter-joins — two lines with butt
                caps would notch. The apex vertex (28, 47.15) puts the mitred
                outer tip at y≈56, a point on the bottom rim. */}
            <path
              d="M14.36 1.61 L28 47.15 L41.64 1.61"
              strokeLinejoin="miter"
              strokeMiterlimit={12}
            />
            {/* Crossbar: upper third, spanning the leg centrelines, ~0.82 of
                the legs' weight. */}
            <line
              x1="19.96"
              y1="20.26"
              x2="36.04"
              y2="20.26"
              strokeWidth={4.17}
            />
          </g>
        </svg>
      </span>
    </Link>
  )
}
