'use client'

import { createContext, useContext } from 'react'
import { useLayoutMode, type LayoutMode } from '../../hooks/useLayoutMode'
import { Nav } from './Nav'
import { Footer } from './Footer'
import { ComposeOverlay } from '../compose/ComposeOverlay'

const LayoutModeContext = createContext<LayoutMode>('platform')

export function useLayoutModeContext(): LayoutMode {
  return useContext(LayoutModeContext)
}

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const mode = useLayoutMode()
  const isWorkspace = mode === 'workspace'

  return (
    <LayoutModeContext.Provider value={mode}>
      <div data-layout-mode={mode}>
        {!isWorkspace && <Nav />}
        {!isWorkspace && <ComposeOverlay />}
        <main className={isWorkspace ? 'min-h-screen' : 'min-h-screen pt-[60px]'}>
          {children}
        </main>
        {!isWorkspace && <Footer />}
      </div>
    </LayoutModeContext.Provider>
  )
}
