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
    <div className="my-16">
      <div className="relative h-24 -mt-24 pointer-events-none" style={{ background: 'linear-gradient(to bottom, transparent, #FAF7F5)' }} />

      <div className="px-8 py-12 text-center bg-surface-sunken">
        <div className="text-center mb-6 text-content-faint" style={{ fontFamily: "'IBM Plex Mono', monospace", letterSpacing: '0.5em', fontSize: '0.75rem' }}>· · ·</div>

        <h2 className="font-serif text-xl font-light mb-3 tracking-tight text-ink-900">{heading}</h2>
        <p className="text-mono-xs mb-8 max-w-sm mx-auto leading-relaxed text-content-secondary">{subtext}</p>

        {showPrice && pricePounds && (
          <p className="font-serif text-2xl font-light mb-6 text-ink-900">£{pricePounds}</p>
        )}

        {error && (
          <div className="mb-6 px-4 py-3 text-mono-xs max-w-sm mx-auto bg-surface-raised text-content-primary">
            {error}
            {error.includes('Add a card') && (
              <a href="/settings" className="ml-1 underline text-ink-900">Go to settings</a>
            )}
          </div>
        )}

        <button onClick={onUnlock} disabled={unlocking} className="btn-accent disabled:opacity-50">
          {unlocking ? 'Unlocking...' : buttonLabel}
        </button>

        <div className="mt-8 flex items-center justify-center gap-4 text-mono-xs text-content-muted">
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
