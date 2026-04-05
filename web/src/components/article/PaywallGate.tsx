'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { ForAllMark } from '../icons/ForAllMark'

interface PaywallGateProps {
  pricePounds: string | null
  freeAllowanceRemaining: number
  hasPaymentMethod: boolean
  isLoggedIn: boolean
  onUnlock: () => void
  unlocking: boolean
  error: string | null
  writerUsername?: string
  writerName?: string
  subscriptionPricePence?: number
  isSubscribed?: boolean
  onSubscribe?: () => void
  subscribing?: boolean
  writerSpendThisMonthPence?: number
  nudgeShownThisMonth?: boolean
  writerId?: string
}

export function PaywallGate({
  pricePounds, freeAllowanceRemaining, hasPaymentMethod, isLoggedIn,
  onUnlock, unlocking, error,
  writerUsername, writerName, subscriptionPricePence, isSubscribed,
  onSubscribe, subscribing,
  writerSpendThisMonthPence, nudgeShownThisMonth, writerId,
}: PaywallGateProps) {
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
  } else {
    heading = 'Keep reading'
    subtext = 'This will be added to your reading tab.'
    buttonLabel = 'Continue reading'
    showPrice = true
  }

  const showSubscribeOption = isLoggedIn && !isSubscribed && subscriptionPricePence && subscriptionPricePence > 0
  const subPricePounds = subscriptionPricePence ? (subscriptionPricePence / 100).toFixed(2) : null

  // Subscription nudge logic
  const spendPounds = writerSpendThisMonthPence != null
    ? (writerSpendThisMonthPence / 100).toFixed(2)
    : null
  const meetsThreshold = writerSpendThisMonthPence != null && subscriptionPricePence != null
    && writerSpendThisMonthPence >= subscriptionPricePence * 0.7
  const overThreshold = writerSpendThisMonthPence != null && subscriptionPricePence != null
    && writerSpendThisMonthPence > subscriptionPricePence
  const showConversionOffer = meetsThreshold && !overThreshold && !nudgeShownThisMonth
  const showOverThresholdNote = overThreshold

  // Mark nudge as shown (one-shot per reader/writer/month)
  const nudgeMarked = useRef(false)
  useEffect(() => {
    if (showConversionOffer && writerId && !nudgeMarked.current) {
      nudgeMarked.current = true
      fetch('/api/v1/nudge/shown', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writerId }),
      }).catch(err => console.error('Failed to log subscription nudge', err))
    }
  }, [showConversionOffer, writerId])

  const gateRef = useRef<HTMLDivElement>(null)
  const [animateEllipsis, setAnimateEllipsis] = useState(false)

  useEffect(() => {
    const el = gateRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setAnimateEllipsis(true); observer.disconnect() } },
      { threshold: 0.3 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="my-16 -mx-[48px]" ref={gateRef}>
      {/* Gradient fade */}
      <div className="relative h-[100px] -mt-[100px] pointer-events-none" style={{ background: 'linear-gradient(to bottom, transparent, #FFFFFF)' }} />

      <div
        className="px-8 py-12 text-center"
        style={{ borderTop: '4px solid #B5242A', borderBottom: '4px solid #B5242A' }}
      >
        {/* Ornament */}
        <div className="text-center mb-6">
          <ForAllMark size={24} className="text-crimson inline-block" />
        </div>

        <h2 className="font-serif text-[26px] font-normal text-black mb-3">{heading}</h2>
        <p className="font-sans text-[15px] text-grey-600 max-w-sm mx-auto mb-8 leading-[1.6]">{subtext}</p>

        {showPrice && pricePounds && (
          <p className="font-serif text-[40px] font-normal text-black mb-6">£{pricePounds}</p>
        )}

        {error && (
          <div className="mb-6 px-4 py-3 text-[12px] font-sans max-w-sm mx-auto bg-grey-100 text-black">
            {error}
          </div>
        )}

        <button onClick={onUnlock} disabled={unlocking} className="btn-accent disabled:opacity-50">
          {unlocking ? 'Unlocking...' : buttonLabel}
        </button>

        {/* Subscribe option */}
        {showSubscribeOption && (
          <div className="mt-6 pt-6 max-w-sm mx-auto" style={{ borderTop: '4px solid #F0F0F0' }}>
            <p className="font-sans text-[14px] text-grey-600 mb-4">
              Or subscribe to {writerName ?? writerUsername} for <strong>£{subPricePounds}/mo</strong> to read everything
            </p>
            {onSubscribe ? (
              <button
                onClick={onSubscribe}
                disabled={subscribing}
                className="btn disabled:opacity-50"
              >
                {subscribing ? 'Subscribing...' : 'Subscribe'}
              </button>
            ) : writerUsername ? (
              <Link href={`/${writerUsername}`} className="btn inline-block">
                Subscribe
              </Link>
            ) : null}

            {/* Spend-threshold subscription nudge */}
            {showConversionOffer && spendPounds && (
              <p className="mt-4 font-mono text-[12px] text-grey-400">
                You&apos;ve spent £{spendPounds} on {writerName ?? writerUsername} this month. Subscribe now and that spending converts to your first month.
              </p>
            )}
            {showOverThresholdNote && spendPounds && subPricePounds && (
              <p className="mt-4 font-mono text-[12px] text-grey-400">
                You&apos;ve spent £{spendPounds} on {writerName ?? writerUsername} this month. A subscription is £{subPricePounds}/mo.
              </p>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
