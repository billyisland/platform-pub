'use client'

import { createContext, useContext } from 'react'
import { usePathname } from 'next/navigation'
import { useLayoutMode, type LayoutMode } from '../../hooks/useLayoutMode'
import { Nav } from './Nav'
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
import { usePaneRedirect } from '../../stores/paneRedirect'

const LayoutModeContext = createContext<LayoutMode>('platform')

export function useLayoutModeContext(): LayoutMode {
  return useContext(LayoutModeContext)
}

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const mode = useLayoutMode()
  // The workspace reader overlay pushes /article|/reader, flipping the URL-derived
  // mode to canvas — but the underlying page is still the workspace. Treat that as
  // chromeless too, else opening the reader mounts the top beam + footer and adds
  // 60px top padding, shifting the (blurred) workspace down behind the overlay.
  const readerOpen = useReader((s) => s.isOpen)
  // The profile overlay pushes /<username> | /author/<id>, flipping the URL-derived
  // mode to canvas while the underlying surface is unchanged — treat it as
  // chromeless too (same reasoning as the reader), so opening a profile from the
  // workspace doesn't mount the top beam + footer behind the frosted overlay.
  const profileOpen = useProfile((s) => s.isOpen)
  // The article editor opens as a global Glasshouse over any surface; treat it as
  // chromeless too (same reasoning as the reader/profile), so the topbar + footer
  // don't mount behind the frosted editor — and so the note→article handoff from
  // a platform page gives a clean full-screen writing surface.
  const editorOpen = useEditorOverlay((s) => s.isOpen)
  // The surface overlay (source / tag / publication) pushes /source|/tag|/pub,
  // flipping the URL-derived mode while the underlying surface is unchanged —
  // treat it as chromeless too (same reasoning as the reader/profile), so the
  // topbar + footer don't mount behind the frosted overlay.
  const surfaceOpen = useSurfaceOverlay((s) => s.isOpen)
  // Standalone surfaces retired off the black topbar (it's reserved for the
  // logged-out marketing/auth register — `/`, `/auth`). `/admin/*` is a
  // logged-in tool that carries its own PageShell + self-navigates back to the
  // workspace; `/about` is a leaf with its own signup CTA. Neither is reachable
  // from the workspace, so dropping the topbar can't strand a navigation.
  const pathname = usePathname()
  const chromelessRoute =
    pathname === '/about' ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/')
  // A standalone pane-backing page (article/profile/surface) bounces a logged-in
  // visitor into the workspace (WorkspacePaneRedirect, which flips this flag).
  // Suppress the topbar while that redirect is pending — auth still resolving, or
  // resolved to a logged-in user — so a member reloading never flashes the
  // retired chrome. A resolved logged-out visitor isn't redirected, so they keep
  // the full page + topbar (the share / SEO view).
  const paneRedirectActive = usePaneRedirect((s) => s.active)
  const authLoading = useAuth((s) => s.loading)
  const authedUser = useAuth((s) => s.user)
  const paneRedirecting =
    paneRedirectActive && (authLoading || Boolean(authedUser))
  const chromeless =
    mode === 'workspace' ||
    chromelessRoute ||
    readerOpen ||
    profileOpen ||
    editorOpen ||
    surfaceOpen ||
    paneRedirecting

  return (
    <LayoutModeContext.Provider value={mode}>
      <div data-layout-mode={mode}>
        {!chromeless && <Nav />}
        {!chromeless && <ComposeOverlay />}
        <main className={chromeless ? 'min-h-screen' : 'min-h-screen pt-[60px]'}>
          {children}
        </main>
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
