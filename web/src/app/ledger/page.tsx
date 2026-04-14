'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { account as accountApi, payment, type TabOverview, type WriterEarnings } from '../../lib/api'
import { BalanceHeader } from '../../components/account/BalanceHeader'
import { AccountLedger } from '../../components/account/AccountLedger'
import { SubscriptionsSection } from '../../components/account/SubscriptionsSection'
import { PledgesSection } from '../../components/account/PledgesSection'
import { PageShell } from '../../components/ui/PageShell'

export default function LedgerPage() {
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
      <PageShell width="content">
        <div className="h-32 animate-pulse bg-white mb-8" />
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-white" />)}</div>
      </PageShell>
    )
  }

  const earningsPence = earnings?.earningsTotalPence ?? 0
  const tabBalance = tab?.balancePence ?? 0
  const netBalance = earningsPence - tabBalance

  return (
    <PageShell width="content" title="Ledger">
      {dataLoading ? (
        <div className="h-32 animate-pulse bg-white mb-8" />
      ) : (
        <BalanceHeader
          balancePence={netBalance}
          freeAllowanceRemainingPence={tab?.freeAllowanceRemainingPence ?? user.freeAllowanceRemainingPence}
          freeAllowanceTotalPence={tab?.freeAllowanceTotalPence ?? 500}
        />
      )}

      <AccountLedger initialIncludeFreeReads={false} />

      <SubscriptionsSection />
      <PledgesSection />
    </PageShell>
  )
}
