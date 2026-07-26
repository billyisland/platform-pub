'use client'

import { createContext, useContext } from 'react'
import { useLayoutMode, type LayoutMode } from '../../hooks/useLayoutMode'
import { PublicNavRow } from '../public/PublicNavRow'
import { NAV_ROW_H } from '../workspace/NavRow'
import { GRID } from '../public/palette'

// The band the fixed nav row reserves at the foot of the viewport: the row plus
// one GRID of clearance, the static mirror of `deriveGeometry`'s navRowH.
// Published as a CSS variable rather than applied as padding — see the note on
// `<main>` below for why the two cases can't share one rule.
const ROW_BAND = NAV_ROW_H + GRID
// Code-split + open-gated (performance audit #4): these four ride in *every*
// page bundle, so deferring them shrinks initial JS sitewide. TipTap (editor)
// is the biggest single win.
import {
  LazyComposeOverlay as ComposeOverlay,
  LazyProfileOverlay as ProfileOverlay,
  LazySurfaceOverlay as SurfaceOverlay,
  LazyEditorOverlay as EditorOverlay,
} from '../workspace/LazyOverlays'
import { LightboxOverlay } from '../ui/LightboxOverlay'
import { PalettePanel } from '../devtools/PalettePanel'
import { PaletteHydrator } from '../devtools/PaletteHydrator'
import { TypeScaleHydrator } from '../TypeScaleHydrator'
import { ColorSchemeHydrator } from '../ColorSchemeHydrator'
import { TributeClaimResumer } from '../tribute/TributeClaimResumer'
import { useReader } from '../../stores/reader'
import { useProfile } from '../../stores/profileOverlay'
import { useSurfaceOverlay } from '../../stores/surfaceOverlay'
import { useEditorOverlay } from '../../stores/editorOverlay'
import { useAuth } from '../../stores/auth'

const LayoutModeContext = createContext<LayoutMode>('platform')

export function useLayoutModeContext(): LayoutMode {
  return useContext(LayoutModeContext)
}

// =============================================================================
// THE BLACK TOPBAR IS GONE (2026-07-25). `Nav` and `LandingNavRow` are deleted.
//
// What it was: a 60px black beam carrying a bare crimson ∀ + white wordmark and,
// for a logged-out visitor, Log in / Join the waiting list plus a mobile sheet.
// It was the last carrier of the retired marketing/auth register.
//
// Why it went rather than being restyled: it had already lost `/`, `/about` and
// `/admin` to a `chromelessRoute` allow-list, so the site shipped two houses at
// once — a visitor landing on `/` met the bone floor, the ⊔ walls and the
// lockup docked in a bottom row; a visitor following a shared article link met
// a black beam. An allow-list that grows every time a page is redesigned is a
// migration in progress, not a design. This finishes it: NOTHING mounts a
// topbar, and the sole chrome a logged-out visitor sees is PublicNavRow — the
// same row, in the same place, on every route.
//
// CONSEQUENCES TO KNOW ABOUT:
//   • `main`'s `pt-[60px]` offset is gone with the beam it cleared.
//   • ComposeOverlay used to be gated on `!chromeless`, which was doing double
//     duty: "there is a topbar" happened to coincide with "this is a logged-in
//     platform page, and no overlay is open". With the topbar gone that
//     predicate is always false, so the gate is now spelled out directly —
//     platform mode, no overlay open. Do not collapse it back into a chrome
//     flag; there is no chrome left to hang it on.
//   • The row's reserved band is published as `--ah-row-band` (NAV_ROW_H +
//     GRID when mounted, 0 otherwise) rather than applied as padding on
//     `main`. It cannot be padding, because the two kinds of public page need
//     the number in opposite ways: a FITTED page (PublicShell — the vessel is
//     wholly on screen and its contents scroll) SUBTRACTS it from its height,
//     while a SCROLLING page (the full-bleed share/SEO surfaces, which have no
//     vessel) ADDS it as bottom padding so its last line clears the row.
//     Padding on `main` would be right for the second and would push the first
//     into overflow. So each page reads the var and does its own arithmetic —
//     `.ah-public-fit` for the fitted case, `padding-bottom` for the other.
// =============================================================================

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const mode = useLayoutMode()
  // The workspace reader overlay pushes /article|/reader, flipping the URL-derived
  // mode to canvas — but the underlying page is still the workspace.
  const readerOpen = useReader((s) => s.isOpen)
  // The profile overlay pushes /<username> | /author/<id>, flipping the
  // URL-derived mode to canvas while the underlying surface is unchanged.
  const profileOpen = useProfile((s) => s.isOpen)
  // The article editor opens as a global Glasshouse over any surface.
  const editorOpen = useEditorOverlay((s) => s.isOpen)
  // The surface overlay (source / tag / publication) pushes /source|/tag|/pub,
  // flipping the URL-derived mode while the underlying surface is unchanged.
  const surfaceOpen = useSurfaceOverlay((s) => s.isOpen)
  const overlayOpen = readerOpen || profileOpen || editorOpen || surfaceOpen

  // The public row is for RESOLVED logged-out visitors only. While auth is
  // still loading we mount nothing: a member reloading a share link would
  // otherwise flash "Log in / Join the waiting list" at themselves before
  // WorkspacePaneRedirect bounces them into the workspace. Same reasoning the
  // retired shell used to suppress the topbar during a pending pane redirect —
  // it just no longer needs a separate flag for it.
  const authLoading = useAuth((s) => s.loading)
  const authedUser = useAuth((s) => s.user)
  const publicVisitor = !authLoading && !authedUser

  const showPublicRow =
    publicVisitor && mode !== 'workspace' && !overlayOpen

  return (
    <LayoutModeContext.Provider value={mode}>
      <div
        data-layout-mode={mode}
        style={
          {
            '--ah-row-band': `${showPublicRow ? ROW_BAND : 0}px`,
          } as React.CSSProperties
        }
      >
        {mode === 'platform' && !overlayOpen && <ComposeOverlay />}
        {/* `min-height: 100dvh` and nothing else. `dvh` not `vh`: on mobile
            Safari `100vh` is the tallest the viewport ever gets, so a fitted
            vessel measured against it hides its bottom wall behind the browser
            chrome. No bottom padding here — see the note above. */}
        <main style={{ minHeight: '100dvh' }}>{children}</main>
        {showPublicRow && <PublicNavRow />}
        {/* Mounted unconditionally — bylines anywhere (incl. the workspace) open it. */}
        <ProfileOverlay />
        {/* Mounted unconditionally — source/tag/publication links anywhere (e.g.
            the FeedComposer source rows) open it without escaping the workspace. */}
        <SurfaceOverlay />
        {/* Mounted unconditionally — "write an article" is reachable from the
            workspace, the dashboard overlay, and the note→article handoff. */}
        <EditorOverlay />
        {/* Mounted unconditionally — any surface (profile avatars, …) enlarges
            an image by calling useLightbox.open(); floats above everything. */}
        <LightboxOverlay />
        {/* Headless — applies persisted palette overrides on boot (the permanent
            hydration mechanism, CLAUDE.md). Always mounted; no UI. */}
        <PaletteHydrator />
        {/* Headless — applies the persisted per-device type-size preference on
            boot. Always mounted; no UI. */}
        <TypeScaleHydrator />
        {/* Headless — applies the persisted per-device light/dark/system
            appearance on boot + tracks the OS preference live. No UI. */}
        <ColorSchemeHydrator />
        {/* Headless — redeems a stashed external tribute-claim token once auth
            resolves (the claim survives signup). Dark behind TRIBUTES_ENABLED. */}
        <TributeClaimResumer />
        {/* Operator-only colour-tuning kit (not a Glasshouse — floats above all
            surfaces, page stays sharp). No shipped menu/settings entry; reach it
            via ?palette or the Ctrl+Alt+P chord (GLASSHOUSE-AND-PALETTE-ADR
            §III.5). Renders null until opened. */}
        <PalettePanel />
      </div>
    </LayoutModeContext.Provider>
  )
}
