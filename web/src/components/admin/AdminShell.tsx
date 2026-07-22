'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { PageShell } from '../ui/PageShell'

// =============================================================================
// Owner dashboard chrome — shared auth guard + tab navigation for /admin/*.
// The admin surface is chromeless (no black topbar), so the shell carries its
// own way back to the workspace. Spec: planning-archive/OWNER-DASHBOARD-SPEC.md
// =============================================================================

const TABS = [
  { href: '/admin/overview', label: 'Overview' },
  { href: '/admin/reports', label: 'Reports' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/content', label: 'Content' },
  { href: '/admin/config', label: 'Config' },
  { href: '/admin/regulatory', label: 'Regulatory' },
] as const

export function AdminShell({
  title,
  width = 'content',
  children,
}: {
  title: string
  width?: 'article' | 'feed' | 'content'
  children: ReactNode
}) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (loading) return
    if (!user || !user.isAdmin) {
      router.replace('/reader')
    }
  }, [user, loading, router])

  if (loading || !user?.isAdmin) {
    return (
      <PageShell width={width}>
        <div className="h-32 animate-pulse bg-white" />
      </PageShell>
    )
  }

  return (
    <PageShell
      width={width}
      title={title}
      action={
        <Link href="/reader" className="btn-text-muted">
          ← Workspace
        </Link>
      }
    >
      <nav aria-label="Owner dashboard sections" className="flex flex-wrap gap-2 mb-8">
        {TABS.map((t) => {
          const active = pathname === t.href || pathname?.startsWith(`${t.href}/`)
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`tab-pill ${active ? 'tab-pill-active' : 'tab-pill-inactive'}`}
              aria-current={active ? 'page' : undefined}
            >
              {t.label}
            </Link>
          )
        })}
      </nav>
      {children}
    </PageShell>
  )
}
