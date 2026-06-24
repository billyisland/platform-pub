'use client'

interface BalanceHeaderProps {
  balancePence: number
  freeAllowanceRemainingPence: number
  freeAllowanceTotalPence: number
  // Upstream Edges Phase 3: earnings reserved for in-flight tributes. Rendered
  // only when > 0 (the tribute money flow is live and this author has a pending
  // share) — "reserved, pending redirect", never "paid to X" (compliance #4).
  reservedForTributesPence?: number
}

export function BalanceHeader({ balancePence, freeAllowanceRemainingPence, freeAllowanceTotalPence, reservedForTributesPence = 0 }: BalanceHeaderProps) {
  const isPositive = balancePence >= 0
  const allowancePct = freeAllowanceTotalPence > 0
    ? Math.round((freeAllowanceRemainingPence / freeAllowanceTotalPence) * 100)
    : 0

  return (
    <div className="bg-glasshouse-well px-6 py-8 mb-8">
      <p className="label-ui text-grey-300 mb-2">Net balance</p>
      <p className={`font-serif text-[40px] font-light tracking-tight ${isPositive ? 'text-black' : 'text-crimson'}`}>
        {!isPositive && '−'}£{(Math.abs(balancePence) / 100).toFixed(2)}
      </p>
      <p className="text-ui-xs text-grey-400 mt-1">
        {isPositive ? 'In credit — settles when threshold reached' : 'Outstanding balance'}
      </p>

      {freeAllowanceTotalPence > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1.5">
            <p className="label-ui text-grey-300">Free allowance</p>
            <p className="font-mono text-mono-xs text-grey-400">
              £{(freeAllowanceRemainingPence / 100).toFixed(2)} of £{(freeAllowanceTotalPence / 100).toFixed(2)}
            </p>
          </div>
          <div className="h-1.5 bg-grey-100 w-full">
            <div className="h-full bg-crimson transition-all" style={{ width: `${allowancePct}%` }} />
          </div>
        </div>
      )}

      {reservedForTributesPence > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1">
            <p className="label-ui text-grey-600">Reserved for tributes</p>
            <p className="font-mono text-mono-xs text-grey-600">
              £{(reservedForTributesPence / 100).toFixed(2)}
            </p>
          </div>
          <p className="text-ui-xs text-grey-600">
            Reserved from your earnings, pending redirect to the sources you credited. It returns to you if an offer isn’t taken up.
          </p>
        </div>
      )}
    </div>
  )
}
