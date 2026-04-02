'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../stores/auth'
import type { MeResponse } from '../../lib/api'
import { useLayoutModeContext } from './LayoutShell'
import { ExportModal } from '../ExportModal'

// ─── Nav link styling (Plex Mono, uppercase) ─────────────────────────────────

function navLinkClass(active: boolean) {
  return [
    'font-mono text-[12px] uppercase tracking-[0.04em] transition-colors px-3 py-1',
    active
      ? 'text-black border-b-2 border-crimson'
      : 'text-grey-400 hover:text-black',
  ].join(' ')
}

// ─── Avatar ──────────────────────────────────────────────────────────────────

function Avatar({ user, size = 32 }: { user: { avatar: string | null; displayName: string | null; username: string | null }; size?: number }) {
  const px = `${size}px`
  if (user.avatar) {
    return <img src={user.avatar} alt="" className="rounded-full object-cover" style={{ width: px, height: px }} />
  }
  return (
    <span
      className="flex items-center justify-center rounded-full bg-grey-100 text-grey-400 font-mono uppercase"
      style={{ width: px, height: px, fontSize: `${Math.round(size * 0.38)}px` }}
    >
      {(user.displayName ?? user.username ?? '?')[0]}
    </span>
  )
}

// ─── Avatar dropdown (the "me" menu) ─────────────────────────────────────────

function AvatarDropdown({ user, onLogout, onClose }: {
  user: MeResponse
  onLogout: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [showExport, setShowExport] = useState(false)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const linkClass = 'block px-4 py-2 text-[14px] text-black hover:bg-grey-100 transition-colors font-sans'

  return (
    <>
      <div ref={ref} className="absolute right-0 top-full mt-2 w-56 bg-white border border-grey-200 shadow-lg z-50">
        {/* Identity */}
        <div className="px-4 py-3 border-b border-grey-200">
          <p className="text-[14px] font-semibold text-black font-sans">{user.displayName ?? user.username}</p>
          {user.username && (
            <p className="text-[12px] text-grey-400 font-mono">@{user.username}</p>
          )}
        </div>

        {/* Group 1: Identity — who I am, who's talking to me */}
        <div className="py-1 border-b border-grey-200">
          <Link href="/profile" onClick={onClose} className={linkClass}>Profile</Link>
          <Link href="/messages" onClick={onClose} className={linkClass}>Messages</Link>
          <Link href="/notifications" onClick={onClose} className={linkClass}>Notifications</Link>
        </div>

        {/* Group 2: Money & content */}
        <div className="py-1 border-b border-grey-200">
          <Link href="/account" onClick={onClose} className={linkClass}>
            <span className="flex items-center justify-between">
              <span>Account</span>
              <span className="text-[12px] text-grey-400 tabular-nums font-mono">
                £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}
              </span>
            </span>
          </Link>
          <Link href="/history" onClick={onClose} className={linkClass}>Reading history</Link>
        </div>

        {/* Group 3: Meta */}
        <div className="py-1">
          <Link href="/settings" onClick={onClose} className={linkClass}>Settings</Link>
          <button
            onClick={() => { setShowExport(true); onClose() }}
            className="block w-full text-left px-4 py-2 text-[14px] text-black hover:bg-grey-100 transition-colors font-sans"
          >
            Export my data
          </button>
          {user.isAdmin && (
            <Link href="/admin" onClick={onClose} className={linkClass}>Admin</Link>
          )}
          <button onClick={onLogout} className="block w-full text-left px-4 py-2 text-[14px] text-grey-600 hover:bg-grey-100 transition-colors font-sans">
            Log out
          </button>
        </div>
      </div>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </>
  )
}

// ─── Mobile sheet ────────────────────────────────────────────────────────────

function MobileSheet({ user, loading, onLogout, onClose, onSearch }: {
  user: MeResponse | null
  loading: boolean
  onLogout: () => void
  onClose: () => void
  onSearch: (q: string) => void
}) {
  const pathname = usePathname()
  const [query, setQuery] = useState('')

  function isActive(path: string) {
    if (path === '/feed') return pathname === '/feed' || pathname === '/'
    return pathname.startsWith(path)
  }

  const linkClass = (path: string) => [
    'block py-3 font-mono text-[12px] uppercase tracking-[0.04em] transition-colors',
    isActive(path) ? 'text-black font-medium' : 'text-grey-400 hover:text-black',
  ].join(' ')

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (query.trim().length >= 2) {
      onSearch(query.trim())
      setQuery('')
    }
  }

  return (
    <div className="fixed inset-x-0 top-[56px] bg-white border-b border-grey-200 z-40 px-6 py-4 shadow-sm">
      {loading ? (
        <div className="h-4 w-24 animate-pulse bg-grey-100" />
      ) : user ? (
        <>
          <Link href="/feed" onClick={onClose} className={linkClass('/feed')}>Feed</Link>
          <Link href="/write" onClick={onClose} className={linkClass('/write')}>Write</Link>
          <Link href="/dashboard" onClick={onClose} className={linkClass('/dashboard')}>Dashboard</Link>
          <Link href="/about" onClick={onClose} className={linkClass('/about')}>About</Link>

          <div className="border-t border-grey-200 my-2" />

          <form onSubmit={handleSearch} className="py-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full bg-grey-100 px-3 py-2 text-[13px] text-black placeholder-grey-300 font-mono"
            />
          </form>

          <div className="border-t border-grey-200 my-2" />

          <Link href="/messages" onClick={onClose} className={linkClass('/messages')}>Messages</Link>
          <Link href="/notifications" onClick={onClose} className={linkClass('/notifications')}>Notifications</Link>

          <div className="border-t border-grey-200 my-2" />

          <Link href="/profile" onClick={onClose} className={linkClass('/profile')}>Profile</Link>
          <Link href="/account" onClick={onClose} className={linkClass('/account')}>Account</Link>
          <Link href="/history" onClick={onClose} className={linkClass('/history')}>Reading history</Link>
          <Link href="/settings" onClick={onClose} className={linkClass('/settings')}>Settings</Link>

          <div className="border-t border-grey-200 my-2" />

          <button
            onClick={() => { onLogout(); onClose() }}
            className="block py-3 font-mono text-[12px] uppercase tracking-[0.04em] text-grey-400 hover:text-black transition-colors"
          >
            Log out
          </button>
        </>
      ) : (
        <>
          <Link href="/feed" onClick={onClose} className={linkClass('/feed')}>Feed</Link>
          <Link href="/about" onClick={onClose} className={linkClass('/about')}>About</Link>

          <div className="border-t border-grey-200 my-2" />

          <Link href="/auth?mode=login" onClick={onClose} className="block py-3 font-mono text-[12px] uppercase tracking-[0.04em] text-grey-400 hover:text-black transition-colors">Log in</Link>
          <Link href="/auth?mode=signup" onClick={onClose} className="inline-block mt-1 btn text-center text-sm">Sign up</Link>
        </>
      )}
    </div>
  )
}

// ─── Main Nav ────────────────────────────────────────────────────────────────

export function Nav() {
  const { user, loading, logout } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const mode = useLayoutModeContext()
  const [searchQuery, setSearchQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // Close mobile sheet on route change
  useEffect(() => { setMenuOpen(false); setDropdownOpen(false) }, [pathname])

  function isActive(path: string) {
    if (path === '/feed') return pathname === '/feed' || pathname === '/'
    if (path === '/dashboard') return pathname.startsWith('/dashboard')
    return pathname === path
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (searchQuery.trim().length >= 2) {
      router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`)
      setSearchQuery('')
    }
  }

  function handleMobileSearch(q: string) {
    router.push(`/search?q=${encodeURIComponent(q)}`)
    setMenuOpen(false)
  }

  const logoHref = user ? '/feed' : '/'

  // ── Canvas mode: minimal bar ───────────────────────────────────────────────

  if (mode === 'canvas') {
    return (
      <>
        <header className="fixed top-0 inset-x-0 z-50 bg-white/95 backdrop-blur-sm border-b border-grey-100">
          <div className="flex items-center justify-between px-6 h-[56px] max-w-content mx-auto">
            {/* Logo — small, grey */}
            <Link
              href={logoHref}
              className="font-serif text-[16px] font-medium italic text-grey-400 hover:text-grey-600 transition-colors"
            >
              Platform
            </Link>

            {/* Back to feed */}
            <Link
              href="/feed"
              className="font-mono text-[12px] uppercase tracking-[0.04em] text-grey-400 hover:text-black transition-colors"
            >
              &#8592; Feed
            </Link>

            {/* Avatar (if logged in) */}
            <div className="flex items-center">
              {!loading && user && (
                <div className="relative">
                  <button onClick={() => setDropdownOpen(!dropdownOpen)}>
                    <Avatar user={user} size={28} />
                  </button>
                  {dropdownOpen && (
                    <AvatarDropdown
                      user={user}
                      onLogout={logout}
                      onClose={() => setDropdownOpen(false)}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </header>
        {menuOpen && (
          <MobileSheet user={user} loading={loading} onLogout={logout} onClose={() => setMenuOpen(false)} onSearch={handleMobileSearch} />
        )}
      </>
    )
  }

  // ── Platform mode: full top bar ────────────────────────────────────────────

  return (
    <>
      <header className="fixed top-0 inset-x-0 z-50 bg-white border-b border-grey-200 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="flex items-center justify-between px-6 h-[56px] max-w-content mx-auto">

          {/* Left: logo + nav links */}
          <div className="flex items-center gap-6">
            {/* Logo */}
            <Link
              href={logoHref}
              className="font-serif text-[22px] font-medium italic text-crimson hover:text-crimson-dark transition-colors flex-shrink-0"
            >
              Platform
            </Link>

            {/* Nav links — hidden on mobile */}
            <nav className="hidden md:flex items-center gap-1">
              {loading ? (
                <div className="h-3 w-32 animate-pulse bg-grey-100" />
              ) : user ? (
                <>
                  <Link href="/feed" className={navLinkClass(isActive('/feed'))}>Feed</Link>
                  <Link href="/write" className={navLinkClass(isActive('/write'))}>Write</Link>
                  <Link href="/dashboard" className={navLinkClass(isActive('/dashboard'))}>Dashboard</Link>
                  <Link href="/about" className={navLinkClass(isActive('/about'))}>About</Link>
                </>
              ) : (
                <>
                  <Link href="/feed" className={navLinkClass(isActive('/feed'))}>Feed</Link>
                  <Link href="/about" className={navLinkClass(isActive('/about'))}>About</Link>
                </>
              )}
            </nav>
          </div>

          {/* Right: search + auth/avatar */}
          <div className="flex items-center gap-4">
            {/* Search — hidden on mobile */}
            <form onSubmit={handleSearch} className="hidden md:block">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search…"
                className="w-36 bg-grey-100 px-3 py-1.5 text-[12px] text-black placeholder-grey-300 font-mono focus:w-52 transition-all border-none"
              />
            </form>

            {loading ? (
              <div className="h-8 w-8 animate-pulse bg-grey-100 rounded-full" />
            ) : user ? (
              /* Avatar + dropdown */
              <div className="relative hidden md:block">
                <button onClick={() => setDropdownOpen(!dropdownOpen)} className="flex items-center">
                  <Avatar user={user} size={32} />
                </button>
                {dropdownOpen && (
                  <AvatarDropdown
                    user={user}
                    onLogout={logout}
                    onClose={() => setDropdownOpen(false)}
                  />
                )}
              </div>
            ) : (
              /* Logged-out auth links */
              <div className="hidden md:flex items-center gap-3">
                <Link
                  href="/auth?mode=login"
                  className="font-mono text-[12px] uppercase tracking-[0.04em] text-grey-400 hover:text-black transition-colors"
                >
                  Log in
                </Link>
                <Link href="/auth?mode=signup" className="btn btn-sm">
                  Sign up
                </Link>
              </div>
            )}

            {/* Hamburger — mobile only */}
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex flex-col justify-center gap-[5px] w-6 h-6 md:hidden"
              aria-label="Menu"
            >
              <span className={`block w-full h-[2px] bg-black transition-transform ${menuOpen ? 'rotate-45 translate-y-[7px]' : ''}`} />
              <span className={`block w-full h-[2px] bg-black transition-opacity ${menuOpen ? 'opacity-0' : ''}`} />
              <span className={`block w-full h-[2px] bg-black transition-transform ${menuOpen ? '-rotate-45 -translate-y-[7px]' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile sheet */}
      {menuOpen && (
        <MobileSheet user={user} loading={loading} onLogout={logout} onClose={() => setMenuOpen(false)} onSearch={handleMobileSearch} />
      )}
    </>
  )
}
