'use client'

import Link from 'next/link'
import { useResolvedDark } from '../../stores/colorScheme'
import { ForallDisc } from './ForallDisc'

// =============================================================================
// ForallLockup — the STATIC lockup (wordmark + ∀ disc, adjacent) for surfaces
// that need the mark but not the menu.
//
// `ForallMenu anchor="row"` is the member lockup: it carries the workspace
// menu, the ∀↔X morph, the hover spin, the unread badge and the Explain
// chrome-swap. A logged-out visitor has no workspace to navigate, so mounting
// it on `/` would ship ~950 lines of menu for a mark. This component renders
// the same two things in the same relationship and nothing else. The disc
// itself is `ForallDisc` (the ADR-locked geometry lives there); this component
// owns only the wordmark + their pairing.
//
// The wordmark matches the disc's GROUND, not its glyph — ink on the light row,
// bone on the inverted one — so it reads `useResolvedDark` the same way the disc
// does. That single boolean is the only reason this is a client component.
// =============================================================================

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
  const wordmarkColor = dark ? 'var(--ah-bone)' : 'var(--ah-ink-925)'

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
          (text · glyph). */}
      <span
        className="font-sans font-medium leading-none"
        style={{
          fontSize: wordmarkSize,
          color: wordmarkColor,
          letterSpacing: '-0.01em',
        }}
      >
        all.haus
      </span>

      <ForallDisc size={discSize} />
    </Link>
  )
}
