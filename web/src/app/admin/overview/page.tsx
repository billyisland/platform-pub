'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  adminDashboard,
  type AdminOverview,
  type AdminAllocationCoverage,
} from '../../../lib/api'
import { formatPence, timeAgo } from '../../../lib/format'
import { AdminShell } from '../../../components/admin/AdminShell'
import { StatCard, StatGrid, StatSection } from '../../../components/admin/Stat'

/** Basis points as a percentage. 10000 bps = 100%. */
function pct(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`
}

export default function AdminOverviewPage() {
  const [data, setData] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [actionResult, setActionResult] = useState<string | null>(null)
  // Segregation is its own fetch across a service boundary (gateway → payment
  // service). Kept out of the overview's state so an unreachable payment
  // service costs this panel and not the whole money dashboard.
  const [segregation, setSegregation] = useState<AdminAllocationCoverage | null>(null)
  const [segregationError, setSegregationError] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await adminDashboard.overview())
      setError(null)
    } catch {
      setError('Failed to load the overview.')
    }
    try {
      setSegregation(await adminDashboard.allocationCoverage())
      setSegregationError(false)
    } catch {
      setSegregationError(true)
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

          {/* W4 per-account halts. A SEPARATE banner from the platform-wide one
              above, never a merged "payouts halted": these are two different
              controls cleared two different ways, and an operator who read one
              as the other would resume the wrong thing. Rendered whether or not
              the global halt is also up — they can both be in force. */}
          {data.payout.haltedAccounts.length > 0 && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className="label-ui text-crimson mb-1">
                {data.payout.haltedAccounts.length} account
                {data.payout.haltedAccounts.length === 1 ? '' : 's'} frozen — everyone else is being paid
              </p>
              <div className="space-y-1">
                {data.payout.haltedAccounts.map((h) => (
                  <p key={h.accountId} className="text-ui-xs text-black">
                    <span className="font-medium">{h.displayName ?? h.username ?? h.accountId}</span>
                    {' · '}
                    <span className="label-ui text-grey-600">{h.mismatchClass}</span>
                    {' · '}
                    {h.reason}
                    {` Since ${timeAgo(h.since)}.`}
                  </p>
                ))}
              </div>
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
                warn={data.custody.holdingDurationDays > data.custody.holdingWarningDays}
              />
            </StatGrid>
          </StatSection>

          {/* W2 — funds segregation as a measured number. The two figures here
              are DIFFERENT measurements and are never to be merged into one
              "segregation %": coverage is charge-side (of what readers paid,
              how much Stripe held allocated), residual is payout-side (of what
              we paid out, how much came from platform balance). Neither is
              derivable from the other. Every absent measurement is rendered in
              WORDS — a fake 0% would assert that none of the platform's reader
              money is segregated, which is the most alarming thing this panel
              can say, and it would say it every day the flag ships dark. */}
          <StatSection
            label="Funds segregation"
            helper="How the settled money is held, measured over 30 days — never asserted."
          >
            {/* Names no culprit on purpose. This read crosses web → gateway →
                payment service, and the browser cannot tell which hop failed —
                the first version said "the payment service did not answer" and
                sent a prod diagnosis chasing the wrong container when the fault
                was a token mismatch at the gateway. The gateway logs the
                upstream status on any non-2xx, so point there instead. */}
            {segregationError && (
              <p className="text-ui-xs text-grey-600">
                Unavailable — the segregation figures could not be read. This is not a coverage
                figure of zero; check the gateway log for the upstream status.
              </p>
            )}
            {/* The overview lands one round trip before this does, so the
                section would otherwise stand empty under its own heading for a
                moment — which reads as "nothing to report". */}
            {!segregation && !segregationError && (
              <p className="text-ui-xs text-grey-600">Measuring…</p>
            )}
            {segregation && !segregation.allocatedFundsEnabled && (
              <p className="text-ui-xs text-grey-600">
                Allocated funds are switched off, so no charge is being segregated and there is
                nothing to measure. Coverage becomes measurable once STRIPE_ALLOCATED_FUNDS is on
                and the allocation sweep has read the charges back.
              </p>
            )}
            {segregation && segregation.allocatedFundsEnabled && (
              <>
                {segregation.coverage === null ? (
                  <p className="text-ui-xs text-grey-600">
                    No measured settlements in the last 30 days
                    {segregation.unmeasured.count > 0
                      ? ` — ${segregation.unmeasured.count} settlement(s) are still awaiting an allocation read.`
                      : '.'}{' '}
                    Not a coverage figure of zero.
                  </p>
                ) : (
                  <StatGrid>
                    <StatCard
                      label="Charge-side coverage"
                      value={pct(segregation.coverage.coverageBps)}
                      detail={`${formatPence(segregation.coverage.allocatedPence)} allocated of ${formatPence(segregation.coverage.measuredPence)} charged`}
                      warn={segregation.coverage.coverageBps < 10000}
                    />
                    <StatCard
                      label="Measured settlements"
                      value={segregation.coverage.measuredCount}
                      detail={`Last ${segregation.coverage.windowDays} days`}
                    />
                    <StatCard
                      label="Unallocated"
                      value={segregation.coverage.unallocatedCount}
                      detail={`${formatPence(segregation.coverage.unallocatedPence)} charged with no allocation`}
                      warn={segregation.coverage.unallocatedCount > 0}
                    />
                    {/* Neither covered nor uncovered — charges we have not read
                        yet. Shown so a coverage figure computed over a partial
                        sample can never read as a figure over all of it. */}
                    <StatCard
                      label="Awaiting a read"
                      value={segregation.unmeasured.count}
                      detail={
                        segregation.unmeasured.count > 0
                          ? `${formatPence(segregation.unmeasured.pence)} not counted either way`
                          : 'Every settlement in the window is measured'
                      }
                      warn={segregation.unmeasured.count > 0}
                    />
                  </StatGrid>
                )}
                <p className="text-ui-xs text-grey-600 mt-3">
                  {segregation.residual === null
                    ? 'Payout-side residual: no payouts in the window, so no measurement — a different number from coverage, and not derivable from it.'
                    : `Payout-side residual: ${pct(segregation.residual.residualBps)} of ${formatPence(segregation.residual.totalPence)} paid out moved from platform balance rather than a charge's allocation (alerts above ${pct(segregation.residual.thresholdBps)}). A different number from coverage, and not derivable from it.`}
                </p>
              </>
            )}
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
