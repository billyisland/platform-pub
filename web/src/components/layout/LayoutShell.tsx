'use client'

import { createContext, useContext } from 'react'
import { useLayoutMode, type LayoutMode } from '../../hooks/useLayoutMode'
import { Nav } from './Nav'
import { Footer } from './Footer'
import { ComposeOverlay } from '../compose/ComposeOverlay'
import { ProfileOverlay } from '../workspace/ProfileOverlay'
import { useReader } from '../../stores/reader'
import { useProfile } from '../../stores/profileOverlay'

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
  const chromeless = mode === 'workspace' || readerOpen || profileOpen

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
      </div>
    </LayoutModeContext.Provider>
  )
}
