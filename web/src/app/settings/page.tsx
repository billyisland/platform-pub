'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter, useSearchParams } from 'next/navigation'
import { EmailChange } from '../../components/account/EmailChange'
import { PaymentSection } from '../../components/account/PaymentSection'
import { LinkedAccountsPanel } from '../../components/account/LinkedAccountsPanel'
import { NotificationPreferences } from '../../components/social/NotificationPreferences'
import { ReadingPreferences } from '../../components/account/ReadingPreferences'
import { ExportModal } from '../../components/ExportModal'
import { DangerZone } from '../../components/account/DangerZone'
import { PageShell } from '../../components/ui/PageShell'

export default function SettingsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [showExport, setShowExport] = useState(false)
  const linked = searchParams.get('linked')
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; msg: string } | null>(null)

  useEffect(() => {
    if (linked === 'mastodon') setBanner({ kind: 'ok', msg: 'Mastodon account connected.' })
    else if (linked === 'bluesky') setBanner({ kind: 'ok', msg: 'Bluesky account connected.' })
    else if (linked === 'error') setBanner({ kind: 'error', msg: 'Connection failed. Please try again.' })
    if (linked) {
      const t = setTimeout(() => {
        setBanner(null)
        router.replace('/settings')
      }, 5000)
      return () => clearTimeout(t)
    }
  }, [linked, router])

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  if (loading || !user) {
    return (
      <PageShell width="article">
        <div className="h-6 w-32 animate-pulse bg-white mb-8" />
        <div className="space-y-6">
          {[1, 2, 3].map(i => <div key={i} className="h-24 animate-pulse bg-white" />)}
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell width="article" title="Settings">
      <div className="space-y-8 max-w-md">
        {banner && (
          <div className={`px-4 py-3 text-ui-sm ${banner.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
            {banner.msg}
          </div>
        )}

        <EmailChange />

        <PaymentSection />

        <LinkedAccountsPanel />

        <section className="bg-white px-6 py-5">
          <NotificationPreferences />
        </section>

        <section className="bg-white px-6 py-5">
          <ReadingPreferences />
        </section>

        <div className="bg-white px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Export my data</p>
          <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">Download your data, receipts, and content keys.</p>
          <button onClick={() => setShowExport(true)} className="btn">Export</button>
        </div>

        <DangerZone />
      </div>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </PageShell>
  )
}
