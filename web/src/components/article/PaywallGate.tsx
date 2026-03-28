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
      {/* Gradient fade from parchment to surface-deep */}
      <div className="relative h-20 -mt-20 pointer-events-none" style={{ background: 'linear-gradient(to bottom, transparent, #DDEEE4)' }} />

      <div className="px-8 py-12 text-center" style={{ background: '#DDEEE4' }}>
        {/* Ornament */}
        <div className="text-center mb-6" style={{ fontFamily: "'IBM Plex Mono', monospace", letterSpacing: '0.5em', fontSize: '0.6875rem', color: '#B5242A', userSelect: 'none' }}>· · ·</div>

        <h2 style={{ fontFamily: '"Literata", Georgia, serif', fontSize: '20px', fontWeight: 400, color: '#0F1F18', marginBottom: '12px' }}>{heading}</h2>
        <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '13px', color: '#4A6B5A', maxWidth: '24rem', margin: '0 auto 2rem', lineHeight: 1.6 }}>{subtext}</p>

        {showPrice && pricePounds && (
          <p style={{ fontFamily: '"Literata", Georgia, serif', fontSize: '28px', fontWeight: 400, color: '#0F1F18', marginBottom: '1.5rem' }}>£{pricePounds}</p>
        )}

        {error && (
          <div className="mb-6 px-4 py-3 text-ui-xs max-w-sm mx-auto bg-card text-content-primary">
            {error}
            {error.includes('Add a card') && (
              <a href="/settings" className="ml-1 underline text-ink">Go to settings</a>
            )}
          </div>
        )}

        <button onClick={onUnlock} disabled={unlocking} className="btn-accent disabled:opacity-50">
          {unlocking ? 'Unlocking...' : buttonLabel}
        </button>

        <div className="mt-8 flex items-center justify-center gap-4" style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '12px', color: '#7A9A8A' }}>
          <span>No subscription</span>
          <span style={{ opacity: 0.4 }}>/</span>
          <span>Pay per read</span>
          <span style={{ opacity: 0.4 }}>/</span>
          <span>Cancel anytime</span>
        </div>
      </div>
    </div>
  )
}
