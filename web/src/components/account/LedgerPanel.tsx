'use client'

// =============================================================================
// LedgerPanel — the reading-tab / earnings ledger body, extracted so the
// workspace Glasshouse overlay (LedgerOverlay) owns it. Net balance + free
// allowance up top, then the transaction ledger, active subscriptions and
// pledges. The component keeps a page-capable mode (`inOverlay=false`: wrapped
// in PageShell, with the auth redirect) so it can be hosted standalone if
// needed. When `inOverlay` is set, the panel skips the auth redirect (the
// overlay only mounts for authenticated users) and renders a bare body — the
// overlay supplies the frame, width and title.
// =============================================================================

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { account as accountApi, payment, type TabOverview, type WriterEarnings } from '../../lib/api'
import { tributesEnabled } from '../../lib/api/tributes'
import { BalanceHeader } from './BalanceHeader'
import { AccountLedger } from './AccountLedger'
import { SubscriptionsSection } from './SubscriptionsSection'
import { PledgesSection } from './PledgesSection'
import { PageShell, PageHeader } from '../ui/PageShell'

export function LedgerPanel({ inOverlay = false }: { inOverlay?: boolean }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [tab, setTab] = useState<TabOverview | null>(null)
  const [earnings, setEarnings] = useState<WriterEarnings | null>(null)
  const [dataLoading, setDataLoading] = useState(true)

  useEffect(() => { if (!inOverlay && !loading && !user) router.push('/auth?mode=login') }, [inOverlay, user, loading, router])

  useEffect(() => {
    if (!user) return
    void (async () => {
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
    const skeleton = (
      <>
        <div className="h-32 animate-pulse bg-glasshouse-well mb-8" />
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
      </>
    )
    return inOverlay ? skeleton : <PageShell width="content">{skeleton}</PageShell>
  }

  const earningsPence = earnings?.earningsTotalPence ?? 0
  const tabBalance = tab?.balancePence ?? 0
  const netBalance = earningsPence - tabBalance

  const body = (
    <>
      {inOverlay && <PageHeader title="Ledger" />}
      {dataLoading ? (
        <div className="h-32 animate-pulse bg-glasshouse-well mb-8" />
      ) : (
        <BalanceHeader
          balancePence={netBalance}
          freeAllowanceRemainingPence={tab?.freeAllowanceRemainingPence ?? user.freeAllowanceRemainingPence}
          freeAllowanceTotalPence={tab?.freeAllowanceTotalPence ?? 500}
          reservedForTributesPence={tributesEnabled() ? (earnings?.reservedPence ?? 0) : 0}
        />
      )}

      <AccountLedger initialIncludeFreeReads={false} />

      <SubscriptionsSection />
      <PledgesSection />
    </>
  )

  if (inOverlay) return body
  return <PageShell width="content" title="Ledger">{body}</PageShell>
}
