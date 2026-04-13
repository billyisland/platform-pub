'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { EmailChange } from '../../components/account/EmailChange'
import { PaymentSection } from '../../components/account/PaymentSection'
import { NotificationPreferences } from '../../components/social/NotificationPreferences'
import { ExportModal } from '../../components/ExportModal'
import { DangerZone } from '../../components/account/DangerZone'

export default function SettingsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [showExport, setShowExport] = useState(false)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 py-12">
        <div className="h-6 w-32 animate-pulse bg-white mb-8" />
        <div className="space-y-6">
          {[1, 2, 3].map(i => <div key={i} className="h-24 animate-pulse bg-white" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-article px-4 sm:px-6 py-12">
      <h1 className="font-serif text-2xl font-light text-black tracking-tight mb-10">
        Settings
      </h1>

      <div className="space-y-10 max-w-md">
        <EmailChange />

        <PaymentSection />

        <section className="bg-white px-6 py-5">
          <NotificationPreferences />
        </section>

        <div className="bg-white px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Export my data</p>
          <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">Download your data, receipts, and content keys.</p>
          <button onClick={() => setShowExport(true)} className="btn">Export</button>
        </div>

        <DangerZone />
      </div>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  )
}
