'use client'

import { createContext, useContext } from 'react'
import { useLayoutMode, type LayoutMode } from '../../hooks/useLayoutMode'
import { Nav } from './Nav'
import { Footer } from './Footer'
import { ComposeOverlay } from '../compose/ComposeOverlay'
import { useReader } from '../../stores/reader'

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
  const chromeless = mode === 'workspace' || readerOpen

  return (
    <LayoutModeContext.Provider value={mode}>
      <div data-layout-mode={mode}>
        {!chromeless && <Nav />}
        {!chromeless && <ComposeOverlay />}
        <main className={chromeless ? 'min-h-screen' : 'min-h-screen pt-[60px]'}>
          {children}
        </main>
        {!chromeless && <Footer />}
      </div>
    </LayoutModeContext.Provider>
  )
}
