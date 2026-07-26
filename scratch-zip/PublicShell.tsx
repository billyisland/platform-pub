'use client'

import type { ReactNode } from 'react'

// =============================================================================
// PublicShell — the bone floor and the measure, FITTED TO THE VIEWPORT.
//
// THE PAGE DOES NOT SCROLL. THE VESSEL DOES. (Amended 2026-07-25 after the
// landing-page build.) The first cut let the vessel grow to its content and let
// the page scroll to find its bottom wall. That reads badly for a reason worth
// stating: a ⊔ whose closing wall is below the fold isn't a vessel, it's a
// left-and-right pair of rules, and the visitor has to scroll to discover the
// shape they were supposed to meet on arrival. It also contradicts the
// workspace, where a feed vessel is always wholly on screen and its cards move
// inside it.
//
// So the shell is a fixed-height flex column and the vessel takes the
// remainder. See PublicVessel for the scroll body, which mirrors Vessel.tsx's
// (`flex: 1 1 0`, `minHeight: 0`, `overflowY: auto`, PAD on the scroll body so
// the interior padding scrolls with the cards rather than framing them).
//
// THE HEIGHT MATH LIVES IN CSS, in `.ah-public-fit` (globals.css), because the
// short-viewport fallback is a media query and belongs there rather than in a
// JS branch. Above 480px tall: `calc(100dvh - var(--ah-row-band))`. Below it
// (landscape phones, split-screen) the fit is abandoned — the remainder would
// be too little to hold a card — and the page scrolls with the band reserved as
// padding instead. `--ah-row-band` is set by LayoutShell when the nav row is
// mounted and is 0 otherwise.
//
// `dvh`, NOT `vh`. On mobile Safari `100vh` is the tallest the viewport ever
// gets, so a `vh`-fitted vessel hides its bottom wall behind the browser chrome
// — which is the exact bug this amendment exists to fix.
//
// THE FLOOR IS `--ah-bone`, a neutral slug, so it inverts with the global
// toggle — and it is also the vessel's own interior colour under `basic`, which
// is the point of choosing that colourway: the walls read as ink rules laid on
// a continuous ground rather than as boxes drawn around content. It is also why
// content scrolling out of the open mouth simply vanishes: interior and floor
// are the same colour, so there is no seam to cut against.
//
// TWO MEASURES, NO MORE. `prose` (720) is `/` and `/about`. `form` (480) is
// everything that asks the visitor for something.
// =============================================================================

type Measure = 'prose' | 'form'

const WIDTH: Record<Measure, number> = {
  prose: 720,
  form: 480,
}

interface PublicShellProps {
  children: ReactNode
  measure?: Measure
}

export function PublicShell({ children, measure = 'form' }: PublicShellProps) {
  return (
    <div className="ah-public-fit" style={{ background: 'var(--ah-bone)' }}>
      <div
        style={{
          width: '100%',
          maxWidth: WIDTH[measure],
          // The vessel is the only child and takes the remainder. `minHeight: 0`
          // is load-bearing: without it this flex child refuses to shrink below
          // its content and the scroll body inside never gets a scrollbar.
          flex: '1 1 0',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </div>
  )
}
