'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function TraffologyLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  const navItems = [
    { href: '/traffology', label: 'Feed' },
    { href: '/traffology/overview', label: 'Overview' },
  ]

  return (
    <div className="mx-auto max-w-feed px-4 sm:px-6 py-10">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-1">
          <span className="text-ui-xs font-bold uppercase tracking-[0.14em] text-black">
            ∀ Traffology
          </span>
          <Link
            href="/dashboard"
            className="text-ui-xs text-grey-400 hover:text-black transition-colors"
          >
            Dashboard
          </Link>
        </div>
        <div className="w-full h-1 bg-black" />
      </div>

      {/* Tab nav */}
      <div className="flex gap-0 mb-8">
        {navItems.map((item) => {
          const isActive =
            item.href === '/traffology'
              ? pathname === '/traffology'
              : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-4 py-2 text-ui-xs font-medium border-2 border-black border-r-0 last:border-r-2 transition-colors ${
                isActive
                  ? 'bg-black text-white'
                  : 'bg-transparent text-black hover:bg-grey-100'
              }`}
            >
              {item.label}
            </Link>
          )
        })}
      </div>

      {children}
    </div>
  )
}
