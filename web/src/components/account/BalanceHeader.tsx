'use client'

interface BalanceHeaderProps {
  balancePence: number
  freeAllowanceRemainingPence: number
  freeAllowanceTotalPence: number
}

export function BalanceHeader({ balancePence, freeAllowanceRemainingPence, freeAllowanceTotalPence }: BalanceHeaderProps) {
  const isPositive = balancePence >= 0
  const allowancePct = freeAllowanceTotalPence > 0
    ? Math.round((freeAllowanceRemainingPence / freeAllowanceTotalPence) * 100)
    : 0

  return (
    <div className="bg-white px-6 py-8 mb-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-300 mb-2">Net balance</p>
      <p className={`font-serif text-[40px] font-light tracking-tight ${isPositive ? 'text-black' : 'text-crimson'}`}>
        {!isPositive && '−'}£{(Math.abs(balancePence) / 100).toFixed(2)}
      </p>
      <p className="text-[13px] font-sans text-grey-400 mt-1">
        {isPositive ? 'In credit — settles when threshold reached' : 'Outstanding balance'}
      </p>

      {freeAllowanceTotalPence > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1.5">
            <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-300">Free allowance</p>
            <p className="font-mono text-[11px] text-grey-400">
              £{(freeAllowanceRemainingPence / 100).toFixed(2)} of £{(freeAllowanceTotalPence / 100).toFixed(2)}
            </p>
          </div>
          <div className="h-1.5 bg-grey-100 w-full">
            <div className="h-full bg-crimson transition-all" style={{ width: `${allowancePct}%` }} />
          </div>
        </div>
      )}
    </div>
  )
}
