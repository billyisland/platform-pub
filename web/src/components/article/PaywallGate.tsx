'use client'

interface PaywallGateProps {
  pricePounds: string | null
  freeAllowanceRemaining: number
  hasPaymentMethod: boolean
  isLoggedIn: boolean
  onUnlock: () => void
  unlocking: boolean
  error: string | null
}

export function PaywallGate({ pricePounds, freeAllowanceRemaining, hasPaymentMethod, isLoggedIn, onUnlock, unlocking, error }: PaywallGateProps) {
  let heading: string
  let subtext: string
  let buttonLabel: string
  let showPrice = false

  if (!isLoggedIn) {
    heading = 'Keep reading'
    subtext = 'Create a free account to continue. Your first £5 of reading is on us — no card required.'
    buttonLabel = 'Sign up to read'
  } else if (freeAllowanceRemaining > 0) {
    heading = 'Keep reading'
    subtext = `This article is part of your free reading allowance. You have £${(freeAllowanceRemaining / 100).toFixed(2)} remaining.`
    buttonLabel = 'Continue reading'
  } else if (!hasPaymentMethod) {
    heading = 'Add a payment method to continue'
    subtext = 'Your free reading allowance has been used. Add a card to keep reading.'
    buttonLabel = 'Add payment method'
    showPrice = true
  } else {
    heading = 'Keep reading'
    subtext = 'This will be added to your reading tab.'
    buttonLabel = 'Continue reading'
    showPrice = true
  }

  return (
    <div className="my-16 -mx-[48px]">
      {/* Gradient fade */}
      <div className="relative h-[100px] -mt-[100px] pointer-events-none" style={{ background: 'linear-gradient(to bottom, transparent, #FFFFFF)' }} />

      <div
        className="px-8 py-12 text-center"
        style={{ borderTop: '3px solid #B5242A', borderBottom: '3px solid #B5242A' }}
      >
        {/* Ornament */}
        <div className="text-center mb-6 font-mono text-[14px] tracking-[0.5em] text-crimson select-none">· · ·</div>

        <h2 className="font-serif text-[26px] font-normal text-black mb-3">{heading}</h2>
        <p className="font-sans text-[15px] text-grey-600 max-w-sm mx-auto mb-8 leading-[1.6]">{subtext}</p>

        {showPrice && pricePounds && (
          <p className="font-serif text-[40px] font-normal text-black mb-6">£{pricePounds}</p>
        )}

        {error && (
          <div className="mb-6 px-4 py-3 text-[12px] font-sans max-w-sm mx-auto bg-grey-50 text-black border border-grey-200">
            {error}
            {error.includes('Add a card') && (
              <a href="/settings" className="ml-1 underline text-black">Go to settings</a>
            )}
          </div>
        )}

        <button onClick={onUnlock} disabled={unlocking} className="btn-accent disabled:opacity-50">
          {unlocking ? 'Unlocking...' : buttonLabel}
        </button>

        <div className="mt-8 flex items-center justify-center gap-4 font-mono text-[12px] uppercase tracking-[0.02em] text-grey-600">
          <span>No subscription</span>
          <span className="opacity-40">/</span>
          <span>Pay per read</span>
          <span className="opacity-40">/</span>
          <span>Cancel anytime</span>
        </div>
      </div>
    </div>
  )
}
