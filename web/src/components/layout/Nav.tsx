'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import { useAuth } from '../../stores/auth'
import { NotificationBell } from '../ui/NotificationBell'

export function Nav() {
  const { user, loading, logout } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  function isActive(path: string) {
    if (path === '/dashboard') return pathname.startsWith('/dashboard')
    if (path === '/write') return pathname === '/write'
    if (path === '/about') return pathname === '/about'
    if (path === '/following') return pathname === '/following'
    if (path === '/followers') return pathname === '/followers'
    if (path === '/profile') return pathname === '/profile'
    if (path === '/search') return pathname === '/search'
    if (path === '/history') return pathname === '/history'
    return false
  }

  // Top bar link style (mobile / tablet)
  function topLinkClass(path: string) {
    return `font-serif text-sm transition-colors px-2.5 py-1 ${
      isActive(path)
        ? 'text-ink-900 border-b-2 border-crimson'
        : 'text-ink-400 hover:text-ink-900'
    }`
  }

  // Left sidebar link style (desktop)
  function sidebarLinkClass(path: string) {
    return `block font-serif text-sm py-2.5 pr-4 transition-colors w-full ${
      isActive(path)
        ? 'pl-[13px] border-l-[3px] border-crimson text-ink-900 font-medium'
        : 'pl-4 text-ink-400 hover:text-ink-900'
    }`
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (searchQuery.trim().length >= 2) {
      router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`)
      setSearchQuery('')
      setMenuOpen(false)
      setSearchOpen(false)
    }
  }

  function handleNavClick() {
    setMenuOpen(false)
  }

  const logoHref = user ? '/feed' : '/'

  return (
    <header className="fixed z-50 bg-surface-raised top-0 left-0 right-0 lg:right-auto lg:bottom-0 lg:w-[200px] lg:flex lg:flex-col lg:border-r lg:border-ink-200">

      {/* ================================================================
          TOP BAR — visible below lg breakpoint
          ================================================================ */}
      <div className="flex items-center justify-between px-6 py-3 lg:px-5 lg:pt-7 lg:pb-5 lg:justify-center lg:border-b lg:border-ink-200">
        {/* Logo */}
        <Link
          href={logoHref}
          onClick={handleNavClick}
          className="font-serif tracking-tight flex-shrink-0"
          style={{
            fontFamily: '"Newsreader", Georgia, serif',
            border: '3px solid #111111',
            padding: '2px 14px 4px',
            lineHeight: '1.1',
            fontSize: '34px',
            fontWeight: '600',
            color: '#111111',
          }}
        >
          Platform
        </Link>

        {/* Hamburger — below md only */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="flex flex-col justify-center gap-[5px] w-6 h-6 md:hidden"
          aria-label="Menu"
        >
          <span className="block w-full h-[2px] bg-ink-900" />
          <span className="block w-full h-[2px] bg-ink-900" />
          <span className="block w-full h-[2px] bg-ink-900" />
        </button>

        {/* Desktop inline nav (between md and lg) — shown md+ but hidden lg+ */}
        <div className="hidden md:flex lg:hidden items-center gap-4">
          {loading ? (
            <div className="h-4 w-16 animate-pulse bg-ink-200" />
          ) : user ? (
            <>
              <Link href="/write" className={topLinkClass('/write')}>Write</Link>
              <Link href="/dashboard" className={topLinkClass('/dashboard')}>Dashboard</Link>
              <Link href="/about" className={topLinkClass('/about')}>About</Link>

              <form onSubmit={handleSearch} className="relative flex items-center">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search…"
                  className="w-28 bg-ink-100 px-3 py-1.5 text-xs text-ink-900 placeholder-ink-400 focus:w-44 focus:ring-1 focus:ring-ink-400/40 transition-all"
                />
              </form>

              <Link href={`/profile`} className="flex items-center gap-2 font-serif text-sm text-ink-400 hover:text-ink-900 transition-colors">
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center bg-ink-200 text-[10px] font-medium text-ink-600 rounded-full">
                    {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
                  </span>
                )}
                <span>{user.displayName ?? user.username}</span>
                <span className="text-mono-xs text-ink-400 tabular-nums">
                  £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}
                </span>
              </Link>

              <button onClick={logout} className="font-serif text-sm text-ink-400 hover:text-ink-900 transition-colors">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/about" className={topLinkClass('/about')}>About</Link>
              <Link href="/auth?mode=login" className="font-serif text-sm text-ink-400 hover:text-ink-900 transition-colors">Log in</Link>
              <Link href="/auth?mode=signup" className="btn">Sign up</Link>
            </>
          )}
        </div>
      </div>

      {/* ================================================================
          MOBILE DRAWER — below lg, shown when menuOpen
          ================================================================ */}
      {menuOpen && (
        <div className="md:hidden bg-surface-raised px-6 pb-4 border-t border-ink-200">
          {loading ? (
            <div className="h-4 w-16 animate-pulse bg-ink-200" />
          ) : user ? (
            <>
              <Link href="/write" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-ink-200 ${isActive('/write') ? 'text-white font-medium' : 'text-ink-400'}`}>Write</Link>
              <Link href="/profile" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-ink-200 ${isActive('/profile') ? 'text-white font-medium' : 'text-ink-400'}`}>Profile</Link>
              <Link href="/notifications" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-ink-800 ${pathname === '/notifications' ? 'text-white font-medium' : 'text-ink-400'}`}>Notifications</Link>
              <Link href="/following" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-ink-200 ${isActive('/following') ? 'text-white font-medium' : 'text-ink-400'}`}>Following</Link>
              <Link href="/followers" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-ink-200 ${isActive('/followers') ? 'text-white font-medium' : 'text-ink-400'}`}>Followers</Link>
              <Link href="/history" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-ink-200 ${isActive('/history') ? 'text-white font-medium' : 'text-ink-400'}`}>History</Link>
              <Link href="/dashboard" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-ink-200 ${isActive('/dashboard') ? 'text-white font-medium' : 'text-ink-400'}`}>Dashboard</Link>
              <Link href="/about" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-ink-200 ${isActive('/about') ? 'text-white font-medium' : 'text-ink-400'}`}>About</Link>

              <form onSubmit={handleSearch} className="mt-3">
                <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search..." className="w-full bg-ink-100 px-3 py-2 text-sm text-ink-900 placeholder-ink-400" />
              </form>

              <div className="flex items-center gap-2 mt-3">
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center bg-ink-200 text-[10px] font-medium text-ink-600 rounded-full">
                    {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
                  </span>
                )}
                <span className="font-serif text-sm text-ink-900">{user.displayName ?? user.username}</span>
              </div>

              <button onClick={() => { logout(); setMenuOpen(false) }} className="mt-3 text-sm text-ink-400 hover:text-ink-900 transition-colors">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/about" onClick={handleNavClick} className="block font-serif text-sm py-3 text-ink-400 hover:text-ink-900 transition-colors">About</Link>
              <Link href="/auth?mode=login" onClick={handleNavClick} className="block font-serif text-sm py-3 text-ink-400 hover:text-ink-900 transition-colors">Log in</Link>
              <Link href="/auth?mode=signup" onClick={handleNavClick} className="btn inline-block mt-2">Sign up</Link>
            </>
          )}
        </div>
      )}

      {/* ================================================================
          LEFT SIDEBAR NAV — lg+ only
          ================================================================ */}
      <nav className="hidden lg:flex flex-col flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="px-4 py-3 h-4 w-24 animate-pulse bg-ink-200 rounded" />
        ) : user ? (
          <>
            <Link href="/write" onClick={handleNavClick} className={sidebarLinkClass('/write')}>Write</Link>
            <Link href="/profile" onClick={handleNavClick} className={sidebarLinkClass('/profile')}>Profile</Link>
            <NotificationBell />
            <Link href="/following" onClick={handleNavClick} className={sidebarLinkClass('/following')}>Following</Link>
            <Link href="/followers" onClick={handleNavClick} className={sidebarLinkClass('/followers')}>Followers</Link>
            <Link href="/history" onClick={handleNavClick} className={sidebarLinkClass('/history')}>History</Link>
            <Link href="/dashboard" onClick={handleNavClick} className={sidebarLinkClass('/dashboard')}>Dashboard</Link>
            <Link href="/about" onClick={handleNavClick} className={sidebarLinkClass('/about')}>About</Link>

            {/* Search */}
            {searchOpen ? (
              <form onSubmit={handleSearch} className="mx-3 mt-1 flex items-center gap-2 bg-ink-100 px-3 py-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search..."
                  autoFocus
                  onBlur={() => { if (!searchQuery) setSearchOpen(false) }}
                  className="flex-1 bg-transparent text-xs text-ink-900 placeholder-ink-400 focus:outline-none"
                />
                <button type="button" onClick={() => { setSearchOpen(false); setSearchQuery('') }} className="text-ink-400 hover:text-ink-900 text-xs">×</button>
              </form>
            ) : (
              <button
                onClick={() => setSearchOpen(true)}
                className={`block font-serif text-sm py-2.5 pl-4 pr-4 transition-colors w-full text-left ${
                  isActive('/search') ? 'pl-[13px] border-l-[3px] border-crimson text-ink-900 font-medium' : 'text-ink-400 hover:text-ink-900'
                }`}
              >
                Search
              </button>
            )}
          </>
        ) : (
          <>
            <Link href="/about" onClick={handleNavClick} className={sidebarLinkClass('/about')}>About</Link>
            <Link href="/auth?mode=login" onClick={handleNavClick} className={sidebarLinkClass('/auth')}>Log in</Link>
            <Link href="/auth?mode=signup" onClick={handleNavClick} className="block mx-4 mt-2 btn text-center text-sm">Sign up</Link>
          </>
        )}
      </nav>

      {/* Sidebar bottom — user info */}
      {user && (
        <div className="hidden lg:block border-t border-ink-200 px-4 py-4 space-y-3">
          {/* User */}
          <Link href="/profile" className="flex items-center gap-2 group">
            {user.avatar ? (
              <img src={user.avatar} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center bg-ink-200 text-[10px] font-medium text-ink-600 rounded-full flex-shrink-0">
                {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <p className="font-serif text-xs text-ink-400 leading-tight truncate group-hover:text-ink-900 transition-colors">
                {user.displayName ?? user.username}
              </p>
              <p className="text-[11px] text-ink-400 tabular-nums">
                £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}
              </p>
            </div>
          </Link>

          <button onClick={logout} className="text-xs text-ink-400 hover:text-ink-900 transition-colors">
            Log out
          </button>
        </div>
      )}

    </header>
  )
}
