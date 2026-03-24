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
        ? 'text-white border-b-2 border-crimson'
        : 'text-[#9E9B97] hover:text-white'
    }`
  }

  // Left sidebar link style (desktop)
  function sidebarLinkClass(path: string) {
    return `block font-serif text-sm py-2.5 pr-4 transition-colors w-full ${
      isActive(path)
        ? 'pl-[13px] border-l-[3px] border-crimson text-white font-medium hover:bg-[#141414]'
        : 'pl-4 text-[#9E9B97] hover:text-white hover:bg-[#141414]'
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
    <header className="fixed z-50 bg-[#2A2A2A] top-0 left-0 right-0 lg:right-auto lg:bottom-0 lg:w-[200px] lg:flex lg:flex-col lg:border-r lg:border-[#3a3a3a]">

      {/* ================================================================
          TOP BAR — visible below lg breakpoint
          ================================================================ */}
      <div className="flex items-center justify-between px-6 py-3 lg:px-5 lg:pt-7 lg:pb-5 lg:justify-center lg:border-b lg:border-[#3a3a3a]">
        {/* Logo */}
        <Link
          href={logoHref}
          onClick={handleNavClick}
          className="font-serif tracking-tight flex-shrink-0 border-[3px] border-white text-white"
          style={{
            fontFamily: '"Newsreader", Georgia, serif',
            padding: '2px 14px 4px',
            lineHeight: '1.1',
            fontSize: '34px',
            fontWeight: '600',
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
          <span className="block w-full h-[2px] bg-white" />
          <span className="block w-full h-[2px] bg-white" />
          <span className="block w-full h-[2px] bg-white" />
        </button>

        {/* Desktop inline nav (between md and lg) — shown md+ but hidden lg+ */}
        <div className="hidden md:flex lg:hidden items-center gap-4">
          {loading ? (
            <div className="h-4 w-16 animate-pulse bg-[#3a3a3a]" />
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
                  className="w-28 bg-[#333] px-3 py-1.5 text-xs text-white placeholder-[#9E9B97] focus:w-44 focus:ring-1 focus:ring-white/20 transition-all"
                />
              </form>

              <Link href={`/profile`} className="flex items-center gap-2 font-serif text-sm text-[#9E9B97] hover:text-white transition-colors">
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center bg-[#3a3a3a] text-[10px] font-medium text-[#9E9B97] rounded-full">
                    {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
                  </span>
                )}
                <span>{user.displayName ?? user.username}</span>
                <span className="text-mono-xs text-[#9E9B97] tabular-nums">
                  £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}
                </span>
              </Link>

              <button onClick={logout} className="font-serif text-sm text-[#9E9B97] hover:text-white transition-colors">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/about" className={topLinkClass('/about')}>About</Link>
              <Link href="/auth?mode=login" className="font-serif text-sm text-[#9E9B97] hover:text-white transition-colors">Log in</Link>
              <Link href="/auth?mode=signup" className="btn">Sign up</Link>
            </>
          )}
        </div>
      </div>

      {/* ================================================================
          MOBILE DRAWER — below lg, shown when menuOpen
          ================================================================ */}
      {menuOpen && (
        <div className="md:hidden bg-[#2A2A2A] px-6 pb-4 border-t border-[#3a3a3a]">
          {loading ? (
            <div className="h-4 w-16 animate-pulse bg-[#3a3a3a]" />
          ) : user ? (
            <>
              <Link href="/write" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-[#3a3a3a] ${isActive('/write') ? 'text-white font-medium' : 'text-[#9E9B97] hover:text-white'}`}>Write</Link>
              <Link href="/profile" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-[#3a3a3a] ${isActive('/profile') ? 'text-white font-medium' : 'text-[#9E9B97] hover:text-white'}`}>Profile</Link>
              <Link href="/notifications" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-[#3a3a3a] ${pathname === '/notifications' ? 'text-white font-medium' : 'text-[#9E9B97] hover:text-white'}`}>Notifications</Link>
              <Link href="/following" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-[#3a3a3a] ${isActive('/following') ? 'text-white font-medium' : 'text-[#9E9B97] hover:text-white'}`}>Following</Link>
              <Link href="/followers" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-[#3a3a3a] ${isActive('/followers') ? 'text-white font-medium' : 'text-[#9E9B97] hover:text-white'}`}>Followers</Link>
              <Link href="/history" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-[#3a3a3a] ${isActive('/history') ? 'text-white font-medium' : 'text-[#9E9B97] hover:text-white'}`}>History</Link>
              <Link href="/dashboard" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-[#3a3a3a] ${isActive('/dashboard') ? 'text-white font-medium' : 'text-[#9E9B97] hover:text-white'}`}>Dashboard</Link>
              <Link href="/about" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-[#3a3a3a] ${isActive('/about') ? 'text-white font-medium' : 'text-[#9E9B97] hover:text-white'}`}>About</Link>

              <form onSubmit={handleSearch} className="mt-3">
                <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search..." className="w-full bg-[#333] px-3 py-2 text-sm text-white placeholder-[#9E9B97]" />
              </form>

              <div className="flex items-center gap-2 mt-3">
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center bg-[#3a3a3a] text-[10px] font-medium text-[#9E9B97] rounded-full">
                    {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
                  </span>
                )}
                <span className="font-serif text-sm text-[#9E9B97]">{user.displayName ?? user.username}</span>
              </div>

              <button onClick={() => { logout(); setMenuOpen(false) }} className="mt-3 text-sm text-[#9E9B97] hover:text-white transition-colors">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/about" onClick={handleNavClick} className="block font-serif text-sm py-3 text-[#9E9B97] hover:text-white transition-colors">About</Link>
              <Link href="/auth?mode=login" onClick={handleNavClick} className="block font-serif text-sm py-3 text-[#9E9B97] hover:text-white transition-colors">Log in</Link>
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
          <div className="px-4 py-3 h-4 w-24 animate-pulse bg-[#3a3a3a] rounded" />
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
              <form onSubmit={handleSearch} className="mx-3 mt-1 flex items-center gap-2 bg-[#333] px-3 py-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search..."
                  autoFocus
                  onBlur={() => { if (!searchQuery) setSearchOpen(false) }}
                  className="flex-1 bg-transparent text-xs text-white placeholder-[#9E9B97] focus:outline-none"
                />
                <button type="button" onClick={() => { setSearchOpen(false); setSearchQuery('') }} className="text-[#9E9B97] hover:text-white text-xs">×</button>
              </form>
            ) : (
              <button
                onClick={() => setSearchOpen(true)}
                className={`block font-serif text-sm py-2.5 pl-4 pr-4 transition-colors w-full text-left ${
                  isActive('/search') ? 'pl-[13px] border-l-[3px] border-crimson text-white font-medium hover:bg-[#141414]' : 'text-[#9E9B97] hover:text-white hover:bg-[#141414]'
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
        <div className="hidden lg:block border-t border-[#3a3a3a] px-4 py-4 space-y-3">
          {/* User */}
          <Link href="/profile" className="flex items-center gap-2 group">
            {user.avatar ? (
              <img src={user.avatar} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center bg-[#3a3a3a] text-[10px] font-medium text-[#9E9B97] rounded-full flex-shrink-0">
                {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <p className="font-serif text-xs text-[#9E9B97] leading-tight truncate group-hover:text-white transition-colors">
                {user.displayName ?? user.username}
              </p>
              <p className="text-[11px] text-[#9E9B97] tabular-nums">
                £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}
              </p>
            </div>
          </Link>

          <button onClick={logout} className="text-xs text-[#9E9B97] hover:text-white transition-colors">
            Log out
          </button>
        </div>
      )}

    </header>
  )
}
