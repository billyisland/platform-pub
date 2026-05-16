'use client'

import Link from 'next/link'
import { ForAllMark } from '../icons/ForAllMark'

export function Footer() {
  return (
    <footer className="bg-black mt-16">
      <div className="max-w-content mx-auto px-6 py-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {/* Left: mark + wordmark */}
        <div className="flex items-center gap-2">
          <ForAllMark size={14} className="text-grey-600" />
          <span className="label-ui text-grey-600">all.haus</span>
        </div>

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
