'use client'

import { createContext, useContext } from 'react'
import { useLayoutMode, type LayoutMode } from '../../hooks/useLayoutMode'
import { Nav } from './Nav'
import { Footer } from './Footer'
import { ComposeOverlay } from '../compose/ComposeOverlay'
import { ProfileOverlay } from '../workspace/ProfileOverlay'
import { SurfaceOverlay } from '../workspace/SurfaceOverlay'
import { EditorOverlay } from '../workspace/EditorOverlay'
import { PalettePanel } from '../devtools/PalettePanel'
import { useReader } from '../../stores/reader'
import { useProfile } from '../../stores/profileOverlay'
import { useSurfaceOverlay } from '../../stores/surfaceOverlay'
import { useEditorOverlay } from '../../stores/editorOverlay'

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
  const chromeless =
    mode === 'workspace' || readerOpen || profileOpen || editorOpen || surfaceOpen

  return (
    <LayoutModeContext.Provider value={mode}>
      <div data-layout-mode={mode}>
        {!chromeless && <Nav />}
        {!chromeless && <ComposeOverlay />}
        <main className={chromeless ? 'min-h-screen' : 'min-h-screen pt-[60px]'}>
          {children}
        </main>
        {!chromeless && <Footer />}
        {/* Mounted unconditionally — bylines anywhere (incl. the workspace) open it. */}
        <ProfileOverlay />
        {/* Mounted unconditionally — source/tag/publication links anywhere (e.g.
            the FeedComposer source rows) open it without escaping the workspace. */}
        <SurfaceOverlay />
        {/* Mounted unconditionally — "write an article" is reachable from the
            workspace, the dashboard overlay, and the note→article handoff. */}
        <EditorOverlay />
        {/* TEMPORARY colour-tuning kit (not a Glasshouse — floats above all
            surfaces, applies persisted palette overrides on mount). Remove
            with the ForallMenu "Palette" row once the scheme is final. */}
        <PalettePanel />
      </div>
    </LayoutModeContext.Provider>
  )
}
