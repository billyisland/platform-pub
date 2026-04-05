'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter, useSearchParams } from 'next/navigation'
import { auth } from '../../lib/api'
import { CardSetup } from '../../components/payment/CardSetup'
import { ExportModal } from '../../components/ExportModal'

export default function SettingsPage() {
  const { user, loading, fetchMe } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [upgrading, setUpgrading] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const onboardingComplete = searchParams.get('onboarding') === 'complete'

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])
  useEffect(() => { if (onboardingComplete) fetchMe() }, [onboardingComplete, fetchMe])

  async function handleUpgradeToWriter() {
    setUpgrading(true); setUpgradeError(null)
    try { const result = await auth.connectStripe(); window.location.href = result.stripeConnectUrl }
    catch { setUpgradeError('Failed to start writer setup.'); setUpgrading(false) }
  }

  if (loading || !user) return <div className="mx-auto max-w-lg px-4 sm:px-6 py-12"><div className="h-7 w-20 animate-pulse bg-white mb-10" /><div className="h-28 w-full animate-pulse bg-white mb-8" /></div>

  return (
    <div className="mx-auto max-w-lg px-4 sm:px-6 py-12">
      <h1 className="font-serif text-2xl font-light text-black mb-10 tracking-tight">Settings</h1>

      {!user.stripeConnectKycComplete && (
        <div className="mb-10 bg-white px-6 py-5">
          <p className="label-ui text-grey-400 mb-2">Connect your bank account</p>
          <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">Connect a bank account via Stripe to receive payouts from your published articles.</p>
          {upgradeError && <p className="text-ui-xs text-red-600 mb-3">{upgradeError}</p>}
          <button onClick={handleUpgradeToWriter} disabled={upgrading} className="btn disabled:opacity-50">{upgrading ? 'Setting up...' : 'Connect Stripe'}</button>
        </div>
      )}

      <section className="mb-10">
        <p className="label-ui text-grey-400 mb-4">Payment method</p>
        {user.hasPaymentMethod ? (
          <div className="bg-white px-6 py-4"><div className="flex items-center justify-between"><div><p className="text-ui-sm text-black">Card connected</p><p className="text-ui-xs text-grey-300 mt-0.5">Your reading tab will settle automatically.</p></div><span className="text-ui-xs text-grey-400">Active</span></div></div>
        ) : (
          <div className="bg-white px-6 py-5">
            <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">Add a payment method to keep reading after your free £5 allowance.</p>
            <p className="text-ui-xs text-grey-300 mb-4">Free allowance remaining: £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}</p>
            <CardSetup onSuccess={() => fetchMe()} />
          </div>
        )}
      </section>

      {user.stripeConnectKycComplete && (
        <section className="mb-10">
          <p className="label-ui text-grey-400 mb-4">Writer account</p>
          <div className="bg-white px-6 py-4"><div className="flex items-center justify-between"><div><p className="text-ui-sm text-black">Stripe Connect</p><p className="text-ui-xs text-grey-300 mt-0.5">{user.stripeConnectKycComplete ? 'Verified — payouts are enabled.' : 'Verification pending.'}</p></div><span className="text-ui-xs text-grey-400">{user.stripeConnectKycComplete ? 'Verified' : 'Pending'}</span></div></div>
        </section>
      )}

      <section className="mb-10">
        <p className="label-ui text-grey-400 mb-4">Account</p>
        <div className="bg-white px-6 py-4 space-y-3">
          <div className="flex items-center justify-between"><span className="text-ui-xs text-grey-400">Display name</span><span className="text-ui-sm text-black">{user.displayName}</span></div>
          <div className="rule" />
          <div className="flex items-center justify-between"><span className="text-ui-xs text-grey-400">Username</span><span className="text-ui-sm text-black">@{user.username}</span></div>
          <div className="rule" />
          <div className="flex items-center justify-between"><span className="text-ui-xs text-grey-400">Public key</span><span className="text-ui-xs text-grey-300 truncate max-w-[200px]">{user.pubkey}</span></div>
        </div>
      </section>

      <section>
        <p className="label-ui text-grey-400 mb-4">Export my data</p>
        <div className="bg-white px-6 py-5">
          <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">Download your data, receipts, and content keys.</p>
          <button onClick={() => setShowExport(true)} className="btn">Export</button>
        </div>
      </section>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  )
}
