'use client'

import { useCallback, useEffect, useState } from 'react'
import { adminDashboard, type AdminOverview } from '../../../lib/api'
import { formatPence, timeAgo } from '../../../lib/format'
import { AdminShell } from '../../../components/admin/AdminShell'
import { StatCard, StatGrid, StatSection } from '../../../components/admin/Stat'

export default function AdminOverviewPage() {
  const [data, setData] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [actionResult, setActionResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await adminDashboard.overview())
      setError(null)
    } catch {
      setError('Failed to load the overview.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function trigger(kind: 'settlements' | 'payouts') {
    const prompt =
      kind === 'settlements'
        ? 'Run the monthly settlement check now? Tabs past the fallback window will be charged.'
        : 'Run a payout cycle now? Writers over the threshold will be paid.'
    if (!window.confirm(prompt)) return
    setActing(kind)
    setActionResult(null)
    try {
      if (kind === 'settlements') {
        const r = await adminDashboard.triggerSettlements()
        setActionResult(`Settlement check complete — ${r.settlementTriggered} settlement(s) triggered.`)
      } else {
        const r = await adminDashboard.triggerPayouts()
        setActionResult(
          `Payout cycle complete — ${r.processed} payout(s), ${formatPence(r.totalPaidPence)} paid.`
        )
      }
      await load()
    } catch {
      setActionResult(kind === 'settlements' ? 'Settlement check failed.' : 'Payout cycle failed.')
    } finally {
      setActing(null)
    }
  }

  return (
    <AdminShell title="Site owner">
      {error && <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black mb-8">{error}</div>}
      {!data && !error && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-white" />
          ))}
        </div>
      )}
      {data && (
        <>
          {data.payout.halted && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className="label-ui text-crimson mb-1">Payouts halted</p>
              <p className="text-ui-xs text-black">
                {data.payout.haltReason ?? 'Ledger reconciliation flagged a mismatch.'}
                {data.payout.haltedSince && ` Since ${timeAgo(data.payout.haltedSince)}.`}
              </p>
            </div>
          )}

          <StatSection label="Stage 1 — Accrual" helper="Money owed by readers, not yet charged.">
            <StatGrid>
              <StatCard label="Active tabs" value={data.accrual.activeTabCount} />
              <StatCard label="Accrued on tabs" value={formatPence(data.accrual.totalAccruedPence)} />
              <StatCard
                label="Near threshold"
                value={data.accrual.nearThresholdTabs}
                detail={`≥ 80% of ${formatPence(data.accrual.settlementThresholdPence)}`}
              />
              <StatCard
                label="Reader credit"
                value={formatPence(data.accrual.totalCreditPence)}
                detail="Negative balances (platform owes readers)"
              />
              <StatCard
                label="Provisional reads"
                value={data.accrual.provisionalReadCount}
                detail={formatPence(data.accrual.provisionalTotalPence)}
              />
              <StatCard
                label="Accrued reads"
                value={data.accrual.accruedReadCount}
                detail={formatPence(data.accrual.accruedTotalPence)}
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Stage 2 — Settlement" helper="Readers charged; the platform holds the funds.">
            <StatGrid>
              <StatCard
                label="Pending"
                value={data.settlement.pendingCount}
                detail={formatPence(data.settlement.pendingPence)}
                warn={
                  data.settlement.oldestPendingAt !== null &&
                  Date.now() - new Date(data.settlement.oldestPendingAt).getTime() > 3_600_000
                }
              />
              <StatCard
                label="Completed"
                value={data.settlement.completedCount}
                detail={formatPence(data.settlement.completedPence)}
              />
              <StatCard
                label="Failed"
                value={data.settlement.failedCount}
                warn={data.settlement.failedCount > 0}
              />
              <StatCard
                label="Last settlement"
                value={data.settlement.lastCompletedAt ? timeAgo(data.settlement.lastCompletedAt) : '—'}
              />
              <StatCard
                label="Charged back"
                value={data.settlement.chargedBackReadCount}
                detail={formatPence(data.settlement.chargedBackPence)}
                warn={data.settlement.chargedBackReadCount > 0}
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Stage 3 — Payout" helper="The platform pays writers.">
            <StatGrid>
              <StatCard
                label="Writers awaiting"
                value={data.payout.writersAwaitingPayout}
                detail={`${formatPence(data.payout.outstandingEarningsPence)} outstanding`}
              />
              <StatCard
                label="In flight"
                value={data.payout.pendingCount + data.payout.initiatedCount}
                detail={formatPence(data.payout.pendingPence + data.payout.initiatedPence)}
              />
              <StatCard
                label="Completed (all time)"
                value={data.payout.completedCount}
                detail={formatPence(data.payout.completedPence)}
              />
              <StatCard
                label="Failed"
                value={data.payout.failedCount}
                detail={data.payout.failedCount > 0 ? formatPence(data.payout.failedPence) : undefined}
                warn={data.payout.failedCount > 0}
              />
              <StatCard
                label="Reversed"
                value={data.payout.reversedCount}
                warn={data.payout.reversedCount > 0}
              />
              <StatCard
                label="Last payout"
                value={data.payout.lastPayoutAt ? timeAgo(data.payout.lastPayoutAt) : '—'}
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Platform revenue" helper="Platform fees on completed settlements.">
            <StatGrid>
              <StatCard label="All time" value={formatPence(data.revenue.allTimePlatformFeePence)} />
              <StatCard label="Last 30 days" value={formatPence(data.revenue.last30DaysPlatformFeePence)} />
              <StatCard label="Last 7 days" value={formatPence(data.revenue.last7DaysPlatformFeePence)} />
              <StatCard label="Today" value={formatPence(data.revenue.todayPlatformFeePence)} />
            </StatGrid>
          </StatSection>

          <StatSection
            label="Custodial exposure"
            helper="Settled reader money held before writer payout."
          >
            <StatGrid>
              <StatCard label="Held" value={formatPence(data.custody.totalHeldPence)} />
              <StatCard label="Held reads" value={data.custody.heldReadCount} />
              <StatCard
                label="Oldest holding"
                value={`${data.custody.holdingDurationDays}d`}
                warn={data.custody.holdingDurationDays > 14}
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Counts">
            <StatGrid>
              <StatCard label="Accounts" value={data.counts.totalAccounts} />
              <StatCard label="Active" value={data.counts.activeAccounts} />
              <StatCard label="Publishing writers" value={data.counts.publishingWriters} />
              <StatCard label="Readers ever" value={data.counts.readersEver} />
              <StatCard label="Cards on file" value={data.counts.readersWithCard} />
              <StatCard
                label="Open reports"
                value={data.counts.openReportCount}
                warn={data.counts.openReportCount > 0}
              />
            </StatGrid>
          </StatSection>

          <div className="slab-rule-4 mb-8" />
          <StatSection
            label="Manual triggers"
            helper="Both run in the payment service exactly as the scheduled crons do."
          >
            <div className="flex flex-wrap gap-3">
              <button
                className="btn-soft"
                disabled={acting !== null}
                onClick={() => void trigger('settlements')}
              >
                {acting === 'settlements' ? 'Running…' : 'Run monthly settlement check'}
              </button>
              <button
                className="btn-soft"
                disabled={acting !== null || data.payout.halted}
                onClick={() => void trigger('payouts')}
              >
                {acting === 'payouts' ? 'Running…' : 'Run payout cycle'}
              </button>
            </div>
            {actionResult && <p className="text-ui-xs text-grey-600 mt-3">{actionResult}</p>}
          </StatSection>
        </>
      )}
    </AdminShell>
  )
}
