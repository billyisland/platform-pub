'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter, useSearchParams } from 'next/navigation'
import { auth } from '../../lib/api'
import { CardSetup } from '../../components/payment/CardSetup'

export default function SettingsPage() {
  const { user, loading, fetchMe } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [upgrading, setUpgrading] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  const onboardingComplete = searchParams.get('onboarding') === 'complete'

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])
  useEffect(() => { if (onboardingComplete) fetchMe() }, [onboardingComplete, fetchMe])

  async function handleUpgradeToWriter() {
    setUpgrading(true); setUpgradeError(null)
    try { const result = await auth.connectStripe(); window.location.href = result.stripeConnectUrl }
    catch { setUpgradeError('Failed to start writer setup.'); setUpgrading(false) }
  }

  if (loading || !user) return <div className="mx-auto max-w-lg px-6 py-12"><div className="h-7 w-20 animate-pulse bg-card mb-10" /><div className="h-28 w-full animate-pulse bg-card mb-8" /></div>

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <h1 className="font-serif text-2xl font-light text-ink mb-10 tracking-tight">Settings</h1>

      {!user.stripeConnectKycComplete && (
        <div className="mb-10 bg-card px-6 py-5">
          <p className="label-ui text-content-muted mb-2">Connect your bank account</p>
          <p className="text-ui-xs text-content-secondary leading-relaxed mb-4">Connect a bank account via Stripe to receive payouts from your published articles.</p>
          {upgradeError && <p className="text-ui-xs text-red-600 mb-3">{upgradeError}</p>}
          <button onClick={handleUpgradeToWriter} disabled={upgrading} className="btn disabled:opacity-50">{upgrading ? 'Setting up...' : 'Connect Stripe'}</button>
        </div>
      )}

      <section className="mb-10">
        <p className="label-ui text-content-muted mb-4">Payment method</p>
        {user.hasPaymentMethod ? (
          <div className="bg-card px-6 py-4"><div className="flex items-center justify-between"><div><p className="text-ui-sm text-ink">Card connected</p><p className="text-ui-xs text-content-faint mt-0.5">Your reading tab will settle automatically.</p></div><span className="text-ui-xs text-content-muted">Active</span></div></div>
        ) : (
          <div className="bg-card px-6 py-5">
            <p className="text-ui-xs text-content-secondary mb-4 leading-relaxed">Add a payment method to keep reading after your free £5 allowance.</p>
            <p className="text-ui-xs text-content-faint mb-4">Free allowance remaining: £{(user.freeAllowanceRemainingPence / 100).toFixed(2)}</p>
            <CardSetup onSuccess={() => fetchMe()} />
          </div>
        )}
      </section>

      {user.stripeConnectKycComplete && (
        <section className="mb-10">
          <p className="label-ui text-content-muted mb-4">Writer account</p>
          <div className="bg-card px-6 py-4"><div className="flex items-center justify-between"><div><p className="text-ui-sm text-ink">Stripe Connect</p><p className="text-ui-xs text-content-faint mt-0.5">{user.stripeConnectKycComplete ? 'Verified — payouts are enabled.' : 'Verification pending.'}</p></div><span className="text-ui-xs text-content-muted">{user.stripeConnectKycComplete ? 'Verified' : 'Pending'}</span></div></div>
        </section>
      )}

      <section>
        <p className="label-ui text-content-muted mb-4">Account</p>
        <div className="bg-card px-6 py-4 space-y-3">
          <div className="flex items-center justify-between"><span className="text-ui-xs text-content-muted">Display name</span><span className="text-ui-sm text-ink">{user.displayName}</span></div>
          <div className="rule" />
          <div className="flex items-center justify-between"><span className="text-ui-xs text-content-muted">Username</span><span className="text-ui-sm text-ink">@{user.username}</span></div>
          <div className="rule" />
          <div className="flex items-center justify-between"><span className="text-ui-xs text-content-muted">Public key</span><span className="text-ui-xs text-content-faint truncate max-w-[200px]">{user.pubkey}</span></div>
        </div>
      </section>
    </div>
  )
}
