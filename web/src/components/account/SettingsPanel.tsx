'use client'

// =============================================================================
// SettingsPanel — the account-settings body, extracted so the workspace
// Glasshouse overlay (SettingsOverlay) owns it. Email, payment, linked social
// accounts, notification / reading / privacy preferences, data export, and the
// danger zone. Mirrors LedgerPanel: a page-capable mode (`inOverlay=false`:
// wrapped in PageShell, with the auth redirect) is kept for parity, but the
// overlay is the live surface. When `inOverlay` is set the panel skips the auth
// redirect (the overlay only mounts for authenticated users) and renders a bare
// body — the overlay supplies the frame, width and title.
//
// `initialLinked` is the OAuth-callback flag (mastodon/bluesky/error) forwarded
// from the /settings shim; it drives the transient connect banner.
// =============================================================================

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { invalidateLinkedAccounts } from '../../hooks/useLinkedAccounts'
import { ProfileSection } from './ProfileSection'
import { EmailChange } from './EmailChange'
import { PaymentSection } from './PaymentSection'
import { NetworkReachPanel } from './NetworkReachPanel'
import { NotificationPreferences } from '../social/NotificationPreferences'
import { ReadingPreferences } from './ReadingPreferences'
import { TypeSizeControl } from './TypeSizeControl'
import { ColorModeControl } from './ColorModeControl'
// ThemeSection retired from Settings (GLASSHOUSE-AND-PALETTE-ADR §III.5) — the
// preset-theme picker is no longer user-facing; the file is parked, not deleted.
import { ExportModal } from '../ExportModal'
import { DangerZone } from './DangerZone'
import { PageShell, PageHeader } from '../ui/PageShell'

function bannerFor(linked: string | null): { kind: 'ok' | 'error'; msg: string } | null {
  if (linked === 'mastodon') return { kind: 'ok', msg: 'Mastodon account connected.' }
  if (linked === 'bluesky') return { kind: 'ok', msg: 'Bluesky account connected.' }
  if (linked === 'already-linked')
    return { kind: 'error', msg: 'That account is already connected to another all.haus profile.' }
  if (linked === 'error') return { kind: 'error', msg: 'Connection failed. Please try again.' }
  return null
}

export function SettingsPanel({
  inOverlay = false,
  initialLinked = null,
}: {
  inOverlay?: boolean
  initialLinked?: string | null
}) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [showExport, setShowExport] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; msg: string } | null>(
    () => bannerFor(initialLinked),
  )

  useEffect(() => { if (!inOverlay && !loading && !user) router.push('/auth?mode=login') }, [inOverlay, user, loading, router])

  // Auto-dismiss the connect banner. WorkspaceView already strips the overlay
  // params from the URL, so there's nothing to router.replace away here.
  useEffect(() => {
    if (!banner) return
    const t = setTimeout(() => setBanner(null), 5000)
    return () => clearTimeout(t)
  }, [banner])

  // A successful social connect just changed the user's network presences, but
  // useLinkedAccounts holds a module-level cache that otherwise survives until a
  // full reload — so a card's reply box would keep showing "set one up" until
  // then. Bust the cache on return so every open surface refreshes in place.
  useEffect(() => {
    if (initialLinked === 'bluesky' || initialLinked === 'mastodon') {
      invalidateLinkedAccounts()
    }
  }, [initialLinked])

  if (loading || !user) {
    const skeleton = (
      <>
        <div className="h-6 w-32 animate-pulse bg-glasshouse-well mb-8" />
        <div className="space-y-6">
          {[1, 2, 3].map(i => <div key={i} className="h-24 animate-pulse bg-glasshouse-well" />)}
        </div>
      </>
    )
    return inOverlay ? skeleton : <PageShell width="article">{skeleton}</PageShell>
  }

  const body = (
    <>
      {inOverlay && <PageHeader title="Settings" />}
      <div className="space-y-8 max-w-md">
        {banner && (
          <div className={`px-4 py-3 text-ui-sm ${banner.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
            {banner.msg}
          </div>
        )}

        <ProfileSection />

        <EmailChange />

        <PaymentSection />

        <NetworkReachPanel />

        <section className="bg-glasshouse-well px-6 py-5">
          <NotificationPreferences />
        </section>

        <section className="bg-glasshouse-well px-6 py-5">
          <ReadingPreferences />
        </section>

        <section className="bg-glasshouse-well px-6 py-5">
          <ColorModeControl />
        </section>

        <section className="bg-glasshouse-well px-6 py-5">
          <TypeSizeControl />
        </section>

        <div className="bg-glasshouse-well px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Export my data</p>
          <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">Download your data, receipts, and content keys.</p>
          <button onClick={() => setShowExport(true)} className="btn">Export</button>
        </div>

        <DangerZone />
      </div>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </>
  )

  if (inOverlay) return body
  return <PageShell width="article" title="Settings">{body}</PageShell>
}
