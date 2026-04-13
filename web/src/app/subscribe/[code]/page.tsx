'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '../../../stores/auth'
import { subscriptionOffers, subscribe, type OfferLookup } from '../../../lib/api'

// =============================================================================
// Offer Redeem Page — /subscribe/:code
//
// Public landing page for subscription offer codes. Shows the writer, discount,
// and a subscribe button. Redirects to the writer's profile on success.
// =============================================================================

export default function RedeemOfferPage() {
  const params = useParams<{ code: string }>()
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()

  const [offer, setOffer] = useState<OfferLookup | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [subscribing, setSubscribing] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const result = await subscriptionOffers.lookup(params.code)
        setOffer(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'This offer is not available.')
      } finally {
        setLoading(false)
      }
    })()
  }, [params.code])

  async function handleSubscribe() {
    if (!offer || !user) return
    setSubscribing(true)
    setError(null)
    try {
      await subscribe(offer.writerId, { offerCode: params.code })
      setSuccess(true)
      setTimeout(() => router.push(`/${offer.writerUsername}`), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to subscribe. Please try again.')
    } finally {
      setSubscribing(false)
    }
  }

  if (loading || authLoading) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 py-20">
        <div className="space-y-4">
          <div className="h-8 w-64 animate-pulse bg-grey-100" />
          <div className="h-4 w-48 animate-pulse bg-grey-100" />
          <div className="h-12 w-40 animate-pulse bg-grey-100" />
        </div>
      </div>
    )
  }

  if (error && !offer) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 py-20 text-center">
        <h1 className="font-serif text-2xl italic mb-4">Offer unavailable</h1>
        <p className="text-ui-sm text-grey-400 mb-6">{error}</p>
        <Link href="/" className="btn-text underline underline-offset-4">Back to home</Link>
      </div>
    )
  }

  if (!offer) return null

  const standardDisplay = `\u00A3${(offer.standardPricePence / 100).toFixed(2)}`
  const discountedDisplay = `\u00A3${(offer.discountedPricePence / 100).toFixed(2)}`
  const isFree = offer.discountedPricePence === 0
  const writerName = offer.writerDisplayName ?? offer.writerUsername

  return (
    <div className="mx-auto max-w-article px-4 sm:px-6 py-20">
      {success ? (
        <div className="text-center">
          <h1 className="font-serif text-3xl italic mb-4">Subscribed!</h1>
          <p className="text-ui-sm text-grey-400 mb-2">
            You're now subscribed to {writerName}.
          </p>
          <p className="text-ui-xs text-grey-300">
            Redirecting to their profile…
          </p>
        </div>
      ) : (
        <>
          <p className="label-ui text-grey-400 mb-2">Subscription offer</p>
          <h1 className="font-serif text-3xl italic mb-2">{offer.label}</h1>
          <p className="text-ui-sm text-grey-600 mb-8">
            Subscribe to <Link href={`/${offer.writerUsername}`} className="text-black underline underline-offset-4">{writerName}</Link>
          </p>

          <div className="bg-white px-6 py-6 mb-6 space-y-3">
            <div className="flex items-baseline gap-3">
              {!isFree && (
                <span className="text-grey-300 line-through text-lg">{standardDisplay}/mo</span>
              )}
              <span className="text-black text-2xl font-medium">
                {isFree ? 'Free' : `${discountedDisplay}/mo`}
              </span>
              <span className="label-ui text-crimson">{offer.discountPct}% off</span>
            </div>
            <p className="text-ui-xs text-grey-400">
              {offer.durationMonths
                ? `Discounted rate for ${offer.durationMonths} month${offer.durationMonths > 1 ? 's' : ''}, then ${standardDisplay}/mo`
                : 'Permanent rate'}
            </p>
          </div>

          {error && (
            <div className="bg-red-50 px-4 py-3 text-ui-xs text-red-700 mb-4">{error}</div>
          )}

          {!user ? (
            <div>
              <Link
                href={`/auth?mode=login&redirect=${encodeURIComponent(`/subscribe/${params.code}`)}`}
                className="btn inline-block"
              >
                Sign in to subscribe
              </Link>
            </div>
          ) : (
            <button
              onClick={handleSubscribe}
              disabled={subscribing}
              className="btn disabled:opacity-50"
            >
              {subscribing ? 'Subscribing…' : isFree ? 'Subscribe for free' : `Subscribe for ${discountedDisplay}/mo`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
