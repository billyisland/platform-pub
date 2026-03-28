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

  // Desktop sidebar link style
  function sidebarLinkClass(path: string) {
    return `block font-sans text-sm py-2.5 pr-4 transition-colors w-full ${
      isActive(path)
        ? 'pl-[13px] border-l-2 border-accent text-ink font-semibold'
        : 'pl-4 text-content-muted hover:text-ink'
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
    <header className="fixed z-50 bg-surface top-0 left-0 right-0 lg:right-auto lg:bottom-0 lg:w-[180px] lg:flex lg:flex-col lg:border-r-[3px] lg:border-ink">

      {/* ================================================================
          TOP BAR — visible below lg breakpoint
          ================================================================ */}
      <div className="flex items-center justify-between px-6 py-3 lg:px-5 lg:pt-7 lg:pb-5 lg:justify-center lg:border-b-[3px] lg:border-ink">
        {/* Logo — Literata in ink box */}
        <Link
          href={logoHref}
          onClick={handleNavClick}
          className="flex-shrink-0 border-[2.5px] border-ink text-ink"
          style={{
            fontFamily: '"Literata", Georgia, serif',
            padding: '3px 14px 5px',
            lineHeight: '1.1',
            fontSize: '22px',
            fontWeight: '600',
            letterSpacing: '-0.02em',
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
          <span className="block w-full h-[2px] bg-ink" />
          <span className="block w-full h-[2px] bg-ink" />
          <span className="block w-full h-[2px] bg-ink" />
        </button>

        {/* Desktop inline nav (between md and lg) — shown md+ but hidden lg+ */}
        <div className="hidden md:flex lg:hidden items-center gap-4">
          {loading ? (
            <div className="h-4 w-16 animate-pulse bg-surface-deep" />
          ) : user ? (
            <>
              <Link href="/write" className={`font-sans text-sm transition-colors px-2.5 py-1 ${isActive('/write') ? 'text-ink font-semibold border-b-2 border-accent' : 'text-content-muted hover:text-ink'}`}>Write</Link>
              <Link href="/dashboard" className={`font-sans text-sm transition-colors px-2.5 py-1 ${isActive('/dashboard') ? 'text-ink font-semibold border-b-2 border-accent' : 'text-content-muted hover:text-ink'}`}>Dashboard</Link>
              <Link href="/about" className={`font-sans text-sm transition-colors px-2.5 py-1 ${isActive('/about') ? 'text-ink font-semibold border-b-2 border-accent' : 'text-content-muted hover:text-ink'}`}>About</Link>

              <form onSubmit={handleSearch} className="relative flex items-center">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search…"
                  className="w-28 bg-card px-3 py-1.5 text-xs text-ink placeholder-content-faint focus:w-44 transition-all"
                />
              </form>

              <Link href="/profile" className="flex items-center gap-2 font-sans text-sm text-content-muted hover:text-ink transition-colors">
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center bg-avatar-bg text-[10px] font-medium text-content-muted rounded-full">
                    {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
                  </span>
                )}
                <span>{user.displayName ?? user.username}</span>
                <span className="text-mono-xs text-content-faint tabular-nums">
                  £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}
                </span>
              </Link>

              <button onClick={logout} className="font-sans text-sm text-content-muted hover:text-ink transition-colors">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/about" className={`font-sans text-sm transition-colors px-2.5 py-1 ${isActive('/about') ? 'text-ink font-semibold' : 'text-content-muted hover:text-ink'}`}>About</Link>
              <Link href="/auth?mode=login" className="font-sans text-sm text-content-muted hover:text-ink transition-colors">Log in</Link>
              <Link href="/auth?mode=signup" className="btn">Sign up</Link>
            </>
          )}
        </div>
      </div>

      {/* ================================================================
          MOBILE DRAWER — below lg, shown when menuOpen
          ================================================================ */}
      {menuOpen && (
        <div className="md:hidden bg-surface px-6 pb-4 border-t-[3px] border-ink">
          {loading ? (
            <div className="h-4 w-16 animate-pulse bg-surface-deep" />
          ) : user ? (
            <>
              <Link href="/write" onClick={handleNavClick} className={`block font-sans text-sm py-3 ${isActive('/write') ? 'text-ink font-semibold' : 'text-content-muted hover:text-ink'}`}>Write</Link>
              <Link href="/profile" onClick={handleNavClick} className={`block font-sans text-sm py-3 ${isActive('/profile') ? 'text-ink font-semibold' : 'text-content-muted hover:text-ink'}`}>Profile</Link>
              <Link href="/notifications" onClick={handleNavClick} className={`block font-sans text-sm py-3 ${pathname === '/notifications' ? 'text-ink font-semibold' : 'text-content-muted hover:text-ink'}`}>Notifications</Link>
              <Link href="/following" onClick={handleNavClick} className={`block font-sans text-sm py-3 ${isActive('/following') ? 'text-ink font-semibold' : 'text-content-muted hover:text-ink'}`}>Following</Link>
              <Link href="/followers" onClick={handleNavClick} className={`block font-sans text-sm py-3 ${isActive('/followers') ? 'text-ink font-semibold' : 'text-content-muted hover:text-ink'}`}>Followers</Link>
              <Link href="/dashboard" onClick={handleNavClick} className={`block font-sans text-sm py-3 ${isActive('/dashboard') ? 'text-ink font-semibold' : 'text-content-muted hover:text-ink'}`}>Dashboard</Link>
              <Link href="/about" onClick={handleNavClick} className={`block font-sans text-sm py-3 ${isActive('/about') ? 'text-ink font-semibold' : 'text-content-muted hover:text-ink'}`}>About</Link>

              <form onSubmit={handleSearch} className="mt-3">
                <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search..." className="w-full bg-card px-3 py-2 text-sm text-ink placeholder-content-faint" />
              </form>

              <div className="flex items-center gap-2 mt-3">
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center bg-avatar-bg text-[10px] font-medium text-content-muted rounded-full">
                    {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
                  </span>
                )}
                <span className="font-sans text-sm text-content-muted">{user.displayName ?? user.username}</span>
              </div>

              <button onClick={() => { logout(); setMenuOpen(false) }} className="mt-3 text-sm text-content-muted hover:text-ink transition-colors">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/about" onClick={handleNavClick} className="block font-sans text-sm py-3 text-content-muted hover:text-ink transition-colors">About</Link>
              <Link href="/auth?mode=login" onClick={handleNavClick} className="block font-sans text-sm py-3 text-content-muted hover:text-ink transition-colors">Log in</Link>
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
          <div className="px-4 py-3 h-4 w-24 animate-pulse bg-surface-deep rounded" />
        ) : user ? (
          <>
            <Link href="/write" onClick={handleNavClick} className={sidebarLinkClass('/write')}>Write</Link>
            <Link href="/profile" onClick={handleNavClick} className={sidebarLinkClass('/profile')}>Profile</Link>
            <NotificationBell />
            <Link href="/following" onClick={handleNavClick} className={sidebarLinkClass('/following')}>Following</Link>
            <Link href="/followers" onClick={handleNavClick} className={sidebarLinkClass('/followers')}>Followers</Link>
            <Link href="/dashboard" onClick={handleNavClick} className={sidebarLinkClass('/dashboard')}>Dashboard</Link>
            <Link href="/about" onClick={handleNavClick} className={sidebarLinkClass('/about')}>About</Link>

            {/* Search */}
            {searchOpen ? (
              <form onSubmit={handleSearch} className="mx-3 mt-1 flex items-center gap-2 bg-card px-3 py-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search..."
                  autoFocus
                  onBlur={() => { if (!searchQuery) setSearchOpen(false) }}
                  className="flex-1 bg-transparent text-xs text-ink placeholder-content-faint focus:outline-none"
                />
                <button type="button" onClick={() => { setSearchOpen(false); setSearchQuery('') }} className="text-content-faint hover:text-ink text-xs">×</button>
              </form>
            ) : (
              <button
                onClick={() => setSearchOpen(true)}
                className={`block font-sans text-sm py-2.5 pl-4 pr-4 transition-colors w-full text-left ${
                  isActive('/search') ? 'pl-[13px] border-l-2 border-accent text-ink font-semibold' : 'text-content-muted hover:text-ink'
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
        <div className="hidden lg:block border-t-[3px] border-ink px-4 py-4 space-y-3">
          <Link href="/profile" className="flex items-center gap-2 group">
            {user.avatar ? (
              <img src={user.avatar} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center bg-avatar-bg text-[10px] font-medium text-content-muted rounded-full flex-shrink-0">
                {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <p className="font-sans text-xs text-content-muted leading-tight truncate group-hover:text-ink transition-colors">
                {user.displayName ?? user.username}
              </p>
              <p className="text-[11px] text-content-faint tabular-nums">
                £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}
              </p>
            </div>
          </Link>

          <button onClick={logout} className="text-xs text-content-faint hover:text-ink transition-colors">
            Log out
          </button>
        </div>
      )}

    </header>
  )
}
