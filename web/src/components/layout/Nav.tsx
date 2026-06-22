'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useLayoutModeContext } from './LayoutShell'
import { ForAllMark } from '../icons/ForAllMark'

// ─── Nav link styling (Plex Mono, uppercase, on black) ──────────────────────

function navLinkClass(active: boolean) {
  return [
    'label-ui transition-colors px-3 py-1',
    active
      ? 'text-white border-b-4 border-crimson'
      : 'text-grey-400 hover:text-white',
  ].join(' ')
}

// ─── Wordmark lockup ────────────────────────────────────────────────────────

function Wordmark({ href }: { href: string }) {
  return (
    <Link href={href} className="flex items-center gap-[8px] flex-shrink-0 group">
      <ForAllMark
        size={18}
        className="text-crimson group-hover:text-crimson-dark transition-colors"
      />
      <span
        className="font-sans text-[18px] font-medium text-white leading-none"
        style={{ letterSpacing: '-0.01em' }}
      >
        all.haus
      </span>
    </Link>
  )
}

// ─── Logged-out mobile sheet ────────────────────────────────────────────────
//
// The topbar is the logged-out marketing/auth register only (LayoutShell:
// logged-in surfaces are chromeless — the workspace ∀ is the sole member nav).
// So this sheet carries no member destinations; it's About / Log in / Sign up.

function MobileSheet({ onClose }: { onClose: () => void }) {
  const pathname = usePathname()
  const isActive = (path: string) => pathname.startsWith(path)
  const linkClass = (path: string) => [
    'block py-3 label-ui transition-colors',
    isActive(path) ? 'text-white font-medium' : 'text-grey-400 hover:text-white',
  ].join(' ')

  return (
    <div className="fixed inset-x-0 top-[60px] bg-black z-40 px-6 py-4">
      <Link href="/about" onClick={onClose} className={linkClass('/about')}>About</Link>

      <div style={{ height: '4px', background: 'var(--ah-nav-grey)' }} className="my-3" />

      <Link href="/auth?mode=login" onClick={onClose} className="block py-3 label-ui text-grey-400 hover:text-white transition-colors">Log in</Link>
      <Link href="/auth?mode=signup" onClick={onClose} className="inline-block mt-1 btn-accent text-center text-sm py-2 px-6">Sign up</Link>
    </div>
  )
}

// ─── Main Nav ───────────────────────────────────────────────────────────────
//
// Logged-out chrome only. When a member is logged in we render a bare wordmark
// beam (no menu, no auth CTAs): the only routes that still mount the topbar for
// a logged-in user are transient pre-redirect frames (e.g. `/` before
// HomeRedirect, a retained standalone route before it bounces into the
// workspace overlay), so a full member menu here would be dead duplication of
// the ∀ — and showing "Log in" to a member would be wrong. The bare beam keeps
// that frame neutral and links home.

export function Nav() {
  const { user, loading } = useAuth()
  const pathname = usePathname()
  const mode = useLayoutModeContext()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => { setMenuOpen(false) }, [pathname])

  function isActive(path: string) {
    return pathname === path
  }

  const loggedIn = !loading && !!user
  const logoHref = loggedIn ? '/reader' : '/'

  // ── Canvas mode: minimal black bar, mark only ──────────────────────────────

  if (mode === 'canvas') {
    return (
      <header className="site-topbar fixed top-0 inset-x-0 z-50 bg-black">
        <div className="flex items-center justify-between px-6 h-[60px] max-w-content mx-auto">
          <Link href={logoHref} className="flex-shrink-0 logo-spin">
            <ForAllMark size={18} className="text-crimson hover:text-crimson-dark transition-colors" />
          </Link>
        </div>
      </header>
    )
  }

  // ── Platform mode ──────────────────────────────────────────────────────────

  // Logged in (or auth still resolving on a topbar route): bare beam, no menu.
  if (loggedIn || loading) {
    return (
      <header className="site-topbar fixed top-0 inset-x-0 z-50 bg-black">
        <div className="flex items-center px-6 h-[60px] max-w-content mx-auto">
          <Wordmark href={logoHref} />
        </div>
      </header>
    )
  }

  // Logged out: the marketing/auth register.
  return (
    <>
      <header className="site-topbar fixed top-0 inset-x-0 z-50 bg-black">
        <div className="flex items-center justify-between px-6 h-[60px] max-w-content mx-auto">

          <div className="flex items-center gap-6">
            <Wordmark href="/" />
            <nav className="hidden md:flex items-center gap-1">
              <Link href="/about" className={navLinkClass(isActive('/about'))}>About</Link>
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden md:flex items-center gap-3">
              <Link
                href="/auth?mode=login"
                className="label-ui text-grey-400 hover:text-white transition-colors"
              >
                Log in
              </Link>
              <Link href="/auth?mode=signup" className="btn-accent btn-sm">
                Sign up
              </Link>
            </div>

            {/* Hamburger — mobile only */}
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="relative flex flex-col justify-center gap-[5px] w-6 h-6 md:hidden"
              aria-label="Menu"
            >
              <span className={`block w-full h-[2px] bg-white transition-transform ${menuOpen ? 'rotate-45 translate-y-[7px]' : ''}`} />
              <span className={`block w-full h-[2px] bg-white transition-opacity ${menuOpen ? 'opacity-0' : ''}`} />
              <span className={`block w-full h-[2px] bg-white transition-transform ${menuOpen ? '-rotate-45 -translate-y-[7px]' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {menuOpen && <MobileSheet onClose={() => setMenuOpen(false)} />}
    </>
  )
}
