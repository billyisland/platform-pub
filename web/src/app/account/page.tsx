'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { account as accountApi, payment, type TabOverview, type WriterEarnings } from '../../lib/api'
import { BalanceHeader } from '../../components/account/BalanceHeader'
import { AccountLedger } from '../../components/account/AccountLedger'
import { SubscriptionsSection } from '../../components/account/SubscriptionsSection'
import { PledgesSection } from '../../components/account/PledgesSection'
import { PaymentSection } from '../../components/account/PaymentSection'

export default function AccountPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [tab, setTab] = useState<TabOverview | null>(null)
  const [earnings, setEarnings] = useState<WriterEarnings | null>(null)
  const [dataLoading, setDataLoading] = useState(true)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  useEffect(() => {
    if (!user) return
    ;(async () => {
      try {
        const [tabData, earningsData] = await Promise.all([
          accountApi.getTab(),
          user.isWriter ? payment.getEarnings(user.id).catch(() => null) : Promise.resolve(null),
        ])
        setTab(tabData)
        setEarnings(earningsData)
      } catch {}
      finally { setDataLoading(false) }
    })()
  }, [user])

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-content px-6 py-10">
        <div className="h-32 animate-pulse bg-white mb-8" />
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-white" />)}</div>
      </div>
    )
  }

  // Compute net balance: earnings minus reading costs
  const earningsPence = earnings?.earningsTotalPence ?? 0
  const tabBalance = tab?.balancePence ?? 0
  const netBalance = earningsPence - tabBalance

  return (
    <div className="mx-auto max-w-content px-6 py-10">
      <h1 className="font-serif text-2xl font-light text-black mb-8 tracking-tight">Your account</h1>

      {dataLoading ? (
        <div className="h-32 animate-pulse bg-white mb-8" />
      ) : (
        <BalanceHeader
          balancePence={netBalance}
          freeAllowanceRemainingPence={tab?.freeAllowanceRemainingPence ?? user.freeAllowanceRemainingPence}
          freeAllowanceTotalPence={tab?.freeAllowanceTotalPence ?? 500}
        />
      )}

      <AccountLedger />

      <SubscriptionsSection />
      <PledgesSection />
      <PaymentSection />
    </div>
  )
}
