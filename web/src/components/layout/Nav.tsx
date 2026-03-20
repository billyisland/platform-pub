'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import { useAuth } from '../../stores/auth'

export function Nav() {
  const { user, loading, logout } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  function isActive(path: string) {
    if (path === '/dashboard') return pathname.startsWith('/dashboard')
    if (path === '/feed') return pathname === '/feed'
    if (path === '/write') return pathname === '/write'
    if (path === '/about') return pathname === '/about'
    return false
  }

  function navLinkClass(path: string) {
    return `font-serif text-sm transition-colors px-2.5 py-1 ${
      isActive(path)
        ? 'text-surface-raised border-b-2 border-surface-raised/60'
        : 'text-surface hover:text-surface-raised'
    }`
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (searchQuery.trim().length >= 2) {
      router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`)
      setSearchQuery('')
      setMenuOpen(false)
    }
  }

  function handleNavClick() {
    setMenuOpen(false)
  }

  const logoHref = user ? '/feed' : '/'

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-terracotta">
      <nav className="mx-auto flex max-w-content items-center justify-between px-6 py-3">
        {/* Logo — framed with accent-tinted border */}
        <Link
          href={logoHref}
          onClick={handleNavClick}
          className="font-serif tracking-tight"
          style={{
            border: '3px solid #FDF6F0',
            padding: '2px 14px 4px',
            lineHeight: '1.1',
            fontSize: '1.75rem',
            fontWeight: '500',
            color: '#FDF6F0',
          }}
        >
          Platform
        </Link>

        {/* Hamburger — mobile only */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="flex flex-col justify-center gap-[5px] w-6 h-6 md:hidden"
          aria-label="Menu"
        >
          <span className="block w-full h-[2px] bg-surface-raised" />
          <span className="block w-full h-[2px] bg-surface-raised" />
          <span className="block w-full h-[2px] bg-surface-raised" />
        </button>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-4">
          {loading ? (
            <div className="h-4 w-16 animate-pulse bg-terracotta-dark" />
          ) : user ? (
            <>
              <Link href="/feed" className={navLinkClass('/feed')}>Feed</Link>
              <Link href="/write" className={navLinkClass('/write')}>Write</Link>
              <Link href="/dashboard" className={navLinkClass('/dashboard')}>Dashboard</Link>
              <Link href="/about" className={navLinkClass('/about')}>About</Link>

              <form onSubmit={handleSearch} className="relative flex items-center">
                <svg className="absolute left-2.5 h-3.5 w-3.5 text-surface-sunken pointer-events-none" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="6.5" cy="6.5" r="5" />
                  <line x1="10" y1="10" x2="14.5" y2="14.5" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-28 bg-terracotta-dark pl-8 pr-2 py-1.5 text-xs text-surface-raised placeholder-surface-sunken focus:w-44 focus:ring-1 focus:ring-surface-raised/40 transition-all"
                />
              </form>

              <Link
                href={`/${user.username}`}
                className="flex items-center gap-2 font-serif text-sm text-surface hover:text-surface-raised transition-colors"
              >
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center bg-terracotta-dark text-[10px] font-medium text-surface-raised rounded-full">
                    {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
                  </span>
                )}
                <span>{user.displayName ?? user.username}</span>
                <span className="text-mono-xs text-surface-sunken tabular-nums">
                  £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}
                </span>
              </Link>

              <button onClick={logout} className="font-serif text-sm text-surface-sunken hover:text-surface-raised transition-colors">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/about" className={navLinkClass('/about')}>About</Link>
              <Link href="/auth?mode=login" className="font-serif text-sm text-surface hover:text-surface-raised transition-colors">
                Log in
              </Link>
              <Link href="/auth?mode=signup" className="btn">Sign up</Link>
            </>
          )}
        </div>
      </nav>

      {/* Mobile drawer */}
      {menuOpen && (
        <div className="md:hidden bg-terracotta px-6 pb-4 border-t border-terracotta-dark">
          {loading ? (
            <div className="h-4 w-16 animate-pulse bg-terracotta-dark" />
          ) : user ? (
            <>
              <Link href="/feed" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-terracotta-dark ${isActive('/feed') ? 'text-surface-raised font-medium' : 'text-surface'}`}>Feed</Link>
              <Link href="/write" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-terracotta-dark ${isActive('/write') ? 'text-surface-raised font-medium' : 'text-surface'}`}>Write</Link>
              <Link href="/dashboard" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-terracotta-dark ${isActive('/dashboard') ? 'text-surface-raised font-medium' : 'text-surface'}`}>Dashboard</Link>
              <Link href="/about" onClick={handleNavClick} className={`block font-serif text-sm py-3 border-b border-terracotta-dark ${isActive('/about') ? 'text-surface-raised font-medium' : 'text-surface'}`}>About</Link>

              <form onSubmit={handleSearch} className="mt-3">
                <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search..." className="w-full bg-terracotta-dark px-3 py-2 text-sm text-surface-raised placeholder-surface-sunken" />
              </form>

              <div className="flex items-center gap-2 mt-3">
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center bg-terracotta-dark text-[10px] font-medium text-surface-raised rounded-full">
                    {(user.displayName ?? user.username ?? '?')[0].toUpperCase()}
                  </span>
                )}
                <span className="font-serif text-sm text-surface-raised">{user.displayName ?? user.username}</span>
              </div>

              <button onClick={() => { logout(); setMenuOpen(false) }} className="mt-3 text-sm text-surface-sunken hover:text-surface-raised transition-colors">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/about" onClick={handleNavClick} className="block font-serif text-sm py-3 text-surface">About</Link>
              <Link href="/auth?mode=login" onClick={handleNavClick} className="block font-serif text-sm py-3 text-surface">Log in</Link>
              <Link href="/auth?mode=signup" onClick={handleNavClick} className="btn inline-block mt-2">Sign up</Link>
            </>
          )}
        </div>
      )}
    </header>
  )
}
