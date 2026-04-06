'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../stores/auth'
import type { MeResponse } from '../../lib/api'
import { useLayoutModeContext } from './LayoutShell'
import { ExportModal } from '../ExportModal'
import { ForAllMark } from '../icons/ForAllMark'
import { useUnreadCounts } from '../../stores/unread'

function Badge({ count, className = '' }: { count: number; className?: string }) {
  if (count <= 0) return null
  return (
    <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 bg-crimson text-white text-[11px] font-sans font-semibold leading-none rounded-full ${className}`}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

// ─── Nav link styling (Plex Mono, uppercase, on black) ──────────────────────

function navLinkClass(active: boolean) {
  return [
    'font-mono text-[11px] uppercase tracking-[0.06em] transition-colors px-3 py-1',
    active
      ? 'text-white border-b-4 border-crimson'
      : 'text-grey-400 hover:text-white',
  ].join(' ')
}

// ─── Avatar (square, no border-radius) ──────────────────────────────────────

function NavAvatar({ user, size = 28 }: { user: { avatar: string | null; displayName: string | null; username: string | null }; size?: number }) {
  const px = `${size}px`
  if (user.avatar) {
    return <img src={user.avatar} alt="" className="object-cover" style={{ width: px, height: px }} />
  }
  return (
    <span
      className="flex items-center justify-center bg-grey-200 text-grey-400 font-mono uppercase"
      style={{ width: px, height: px, fontSize: `${Math.round(size * 0.38)}px` }}
    >
      {(user.displayName ?? user.username ?? '?')[0]}
    </span>
  )
}

// ─── Avatar dropdown ────────────────────────────────────────────────────────

function AvatarDropdown({ user, onLogout, onClose }: {
  user: MeResponse
  onLogout: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [showExport, setShowExport] = useState(false)
  const dmCount = useUnreadCounts((s) => s.dmCount)
  const notificationCount = useUnreadCounts((s) => s.notificationCount)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const linkClass = 'block px-4 py-2 text-[14px] text-black hover:bg-grey-100 transition-colors font-sans'

  return (
    <>
      <div ref={ref} role="menu" className="absolute right-0 top-full mt-2 w-56 bg-white shadow-lg z-50">
        {/* Identity */}
        <div className="px-4 py-3" style={{ borderBottom: '4px solid #111111' }}>
          <div className="flex items-center gap-2">
            <NavAvatar user={user} size={32} />
            <div>
              <p className="text-[14px] font-semibold text-black font-sans">{user.displayName ?? user.username}</p>
              {user.username && (
                <p className="text-[11px] text-grey-600 font-mono uppercase tracking-[0.02em]">@{user.username}</p>
              )}
            </div>
          </div>
        </div>

        {/* Group 1 */}
        <div className="py-1">
          <Link href="/profile" onClick={onClose} className={linkClass}>Profile</Link>
          <Link href="/messages" onClick={onClose} className={linkClass}>
            <span className="flex items-center justify-between">
              <span>Messages</span>
              <Badge count={dmCount} />
            </span>
          </Link>
          <Link href="/notifications" onClick={onClose} className={linkClass}>
            <span className="flex items-center justify-between">
              <span>Notifications</span>
              <Badge count={notificationCount} />
            </span>
          </Link>
        </div>

        <div style={{ height: '4px', background: '#F0F0F0' }} />

        {/* Group 2 */}
        <div className="py-1">
          <Link href="/account" onClick={onClose} className={linkClass}>
            <span className="flex items-center justify-between">
              <span>Account</span>
              <span className="text-[11px] text-grey-600 tabular-nums font-mono uppercase tracking-[0.02em]">
                £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}
              </span>
            </span>
          </Link>
          <Link href="/social" onClick={onClose} className={linkClass}>Social</Link>
        </div>

        <div style={{ height: '4px', background: '#F0F0F0' }} />

        {/* Group 3 */}
        <div className="py-1">
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

// ─── Mobile sheet ───────────────────────────────────────────────────────────

function MobileSheet({ user, loading, onLogout, onClose, onSearch }: {
  user: MeResponse | null
  loading: boolean
  onLogout: () => void
  onClose: () => void
  onSearch: (q: string) => void
}) {
  const pathname = usePathname()
  const [query, setQuery] = useState('')
  const [showExport, setShowExport] = useState(false)
  const dmCount = useUnreadCounts((s) => s.dmCount)
  const notificationCount = useUnreadCounts((s) => s.notificationCount)

  function isActive(path: string) {
    if (path === '/feed') return pathname === '/feed' || pathname === '/'
    return pathname.startsWith(path)
  }

  const linkClass = (path: string) => [
    'block py-3 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors',
    isActive(path) ? 'text-white font-medium' : 'text-grey-400 hover:text-white',
  ].join(' ')

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (query.trim().length >= 2) {
      onSearch(query.trim())
      setQuery('')
    }
  }

  return (
    <div className="fixed inset-x-0 top-[60px] bg-black z-40 px-6 py-4">
      {loading ? (
        <div className="h-4 w-24 animate-pulse bg-grey-600" />
      ) : user ? (
        <>
          <Link href="/feed" onClick={onClose} className={linkClass('/feed')}>Feed</Link>
          <Link href="/write" onClick={onClose} className={linkClass('/write')}>Write</Link>
          <Link href="/dashboard" onClick={onClose} className={linkClass('/dashboard')}>Dashboard</Link>
          <Link href="/following" onClick={onClose} className={linkClass('/following')}>Following</Link>

          <div style={{ height: '4px', background: '#333' }} className="my-3" />

          <form onSubmit={handleSearch} className="py-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="SEARCH…"
              className="w-full bg-grey-600/20 px-3 py-2 text-[11px] text-white placeholder-grey-400 font-mono uppercase tracking-[0.06em] border-none"
            />
          </form>

          <div style={{ height: '4px', background: '#333' }} className="my-3" />

          <Link href="/messages" onClick={onClose} className={linkClass('/messages')}>
            <span className="flex items-center gap-2">Messages<Badge count={dmCount} /></span>
          </Link>
          <Link href="/notifications" onClick={onClose} className={linkClass('/notifications')}>
            <span className="flex items-center gap-2">Notifications<Badge count={notificationCount} /></span>
          </Link>

          <div style={{ height: '4px', background: '#333' }} className="my-3" />

          <Link href="/profile" onClick={onClose} className={linkClass('/profile')}>Profile</Link>
          <Link href="/account" onClick={onClose} className={linkClass('/account')}>Account</Link>
          <Link href="/social" onClick={onClose} className={linkClass('/social')}>Social</Link>
          <button
            onClick={() => { setShowExport(true); onClose() }}
            className="block py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-grey-400 hover:text-white transition-colors text-left"
          >
            Export my data
          </button>

          <div style={{ height: '4px', background: '#333' }} className="my-3" />

          <button
            onClick={() => { onLogout(); onClose() }}
            className="block py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-grey-400 hover:text-white transition-colors"
          >
            Log out
          </button>
          {showExport && <ExportModal onClose={() => setShowExport(false)} />}
        </>
      ) : (
        <>
          <Link href="/feed" onClick={onClose} className={linkClass('/feed')}>Feed</Link>
          <Link href="/about" onClick={onClose} className={linkClass('/about')}>About</Link>

          <div style={{ height: '4px', background: '#333' }} className="my-3" />

          <Link href="/auth?mode=login" onClick={onClose} className="block py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-grey-400 hover:text-white transition-colors">Log in</Link>
          <Link href="/auth?mode=signup" onClick={onClose} className="inline-block mt-1 btn-accent text-center text-sm py-2 px-6">Sign up</Link>
        </>
      )}
    </div>
  )
}

// ─── Main Nav ───────────────────────────────────────────────────────────────

export function Nav() {
  const { user, loading, logout } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const mode = useLayoutModeContext()
  const [searchQuery, setSearchQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dmCount = useUnreadCounts((s) => s.dmCount)
  const notificationCount = useUnreadCounts((s) => s.notificationCount)
  const totalUnread = dmCount + notificationCount

  useEffect(() => { setMenuOpen(false); setDropdownOpen(false) }, [pathname])

  function isActive(path: string) {
    if (path === '/feed') return pathname === '/feed' || pathname === '/'
    if (path === '/dashboard') return pathname.startsWith('/dashboard')
    if (path === '/following') return pathname === '/following' || pathname === '/followers'
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

  // ── Canvas mode: minimal black bar, white ∀ ────────────────────────────────

  if (mode === 'canvas') {
    return (
      <>
        <header className="fixed top-0 inset-x-0 z-50 bg-black">
          <div className="flex items-center justify-between px-6 h-[60px] max-w-content mx-auto">
            <Link href={logoHref} className="flex-shrink-0 logo-spin">
              <ForAllMark size={18} className="text-white hover:text-grey-300 transition-colors" />
            </Link>

            <div className="flex items-center">
              {!loading && user && (
                <div className="relative">
                  <button onClick={() => setDropdownOpen(!dropdownOpen)} aria-label="Account menu" aria-expanded={dropdownOpen} className="relative">
                    <NavAvatar user={user} size={28} />
                    {totalUnread > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[16px] h-[16px] px-0.5 bg-crimson text-white text-[10px] font-sans font-semibold leading-none rounded-full">
                        {totalUnread > 99 ? '99+' : totalUnread}
                      </span>
                    )}
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

  // ── Platform mode: full black beam ─────────────────────────────────────────

  return (
    <>
      <header className="fixed top-0 inset-x-0 z-50 bg-black">
        <div className="flex items-center justify-between px-6 h-[60px] max-w-content mx-auto">

          {/* Left: logo + nav links */}
          <div className="flex items-center gap-6">
            <Link
              href={logoHref}
              className="flex items-center gap-[8px] flex-shrink-0 group"
            >
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

            <nav className="hidden md:flex items-center gap-1">
              {loading ? (
                <div className="h-3 w-32 animate-pulse bg-grey-600" />
              ) : user ? (
                <>
                  <Link href="/feed" className={navLinkClass(isActive('/feed'))}>Feed</Link>
                  <Link href="/write" className={navLinkClass(isActive('/write'))}>Write</Link>
                  <Link href="/dashboard" className={navLinkClass(isActive('/dashboard'))}>Dashboard</Link>
                  <Link href="/following" className={navLinkClass(isActive('/following'))}>Following</Link>
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
            <form onSubmit={handleSearch} className="hidden md:block">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="SEARCH…"
                className="w-36 bg-white/10 px-3 py-1.5 text-[11px] text-white placeholder-grey-400 font-mono uppercase tracking-[0.06em] focus:w-52 transition-all border-none"
              />
            </form>

            {loading ? (
              <div className="h-7 w-7 animate-pulse bg-grey-600" />
            ) : user ? (
              <div className="relative hidden md:block">
                <button onClick={() => setDropdownOpen(!dropdownOpen)} aria-label="Account menu" aria-expanded={dropdownOpen} className="relative flex items-center">
                  <NavAvatar user={user} size={28} />
                  {totalUnread > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[16px] h-[16px] px-0.5 bg-crimson text-white text-[10px] font-sans font-semibold leading-none rounded-full">
                      {totalUnread > 99 ? '99+' : totalUnread}
                    </span>
                  )}
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
              <div className="hidden md:flex items-center gap-3">
                <Link
                  href="/auth?mode=login"
                  className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-400 hover:text-white transition-colors"
                >
                  Log in
                </Link>
                <Link href="/auth?mode=signup" className="btn-accent btn-sm">
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
              <span className={`block w-full h-[2px] bg-white transition-transform ${menuOpen ? 'rotate-45 translate-y-[7px]' : ''}`} />
              <span className={`block w-full h-[2px] bg-white transition-opacity ${menuOpen ? 'opacity-0' : ''}`} />
              <span className={`block w-full h-[2px] bg-white transition-transform ${menuOpen ? '-rotate-45 -translate-y-[7px]' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {menuOpen && (
        <MobileSheet user={user} loading={loading} onLogout={logout} onClose={() => setMenuOpen(false)} onSearch={handleMobileSearch} />
      )}
    </>
  )
}
