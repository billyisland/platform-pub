'use client'

import Link from 'next/link'
import { useLayoutModeContext } from './LayoutShell'

export function Footer() {
  const mode = useLayoutModeContext()

  // No footer on canvas (article reading) pages
  if (mode === 'canvas') return null

  return (
    <footer className="border-t border-grey-200 mt-16">
      <div className="max-w-content mx-auto px-6 py-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
        <Link href="/about" className="font-mono text-[11px] uppercase tracking-[0.04em] text-grey-300 hover:text-grey-600 transition-colors">
          About
        </Link>
        <Link href="/community-guidelines" className="font-mono text-[11px] uppercase tracking-[0.04em] text-grey-300 hover:text-grey-600 transition-colors">
          Community Guidelines
        </Link>
        <Link href="/privacy" className="font-mono text-[11px] uppercase tracking-[0.04em] text-grey-300 hover:text-grey-600 transition-colors">
          Privacy
        </Link>
        <Link href="/terms" className="font-mono text-[11px] uppercase tracking-[0.04em] text-grey-300 hover:text-grey-600 transition-colors">
          Terms
        </Link>
      </div>
    </footer>
  )
}
