'use client'

import Link from 'next/link'

export function Footer() {
  return (
    <footer className="site-footer bg-black mt-16">
      <div className="max-w-content mx-auto px-6 py-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {/* Left: wordmark (type alone — the bare ∀ was retired 2026-07-25) */}
        <span className="label-ui text-grey-600">all.haus</span>

        {/* Right: links */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Link href="/about" className="label-ui text-grey-600 hover:text-grey-400 transition-colors">
            About
          </Link>
          <Link href="/community-guidelines" className="label-ui text-grey-600 hover:text-grey-400 transition-colors">
            Guidelines
          </Link>
          <Link href="/privacy" className="label-ui text-grey-600 hover:text-grey-400 transition-colors">
            Privacy
          </Link>
          <Link href="/terms" className="label-ui text-grey-600 hover:text-grey-400 transition-colors">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  )
}
