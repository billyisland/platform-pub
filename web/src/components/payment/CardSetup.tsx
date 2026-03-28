'use client'

import { useState } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js'
import { auth } from '../../lib/api'

// =============================================================================
// Card Setup
//
// Stripe Elements integration for readers to connect a payment method.
// Uses SetupIntent flow (no immediate charge — card is saved for future use).
//
// After successful card setup:
//   1. PaymentMethod ID sent to gateway /auth/connect-card
//   2. Gateway creates/updates Stripe Customer, attaches PM
//   3. Gateway notifies payment service → provisional reads convert to accrued
//   4. Reader can now read paywalled content charged to their tab
// =============================================================================

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? 'pk_test_placeholder'
)

interface CardSetupProps {
  onSuccess: () => void
}

export function CardSetup({ onSuccess }: CardSetupProps) {
  return (
    <Elements
      stripe={stripePromise}
      options={{
        appearance: {
          theme: 'stripe',
          variables: {
            colorPrimary: '#0F1F18',
            colorText: '#0F1F18',
            fontFamily: '"Source Sans 3", system-ui, sans-serif',
            borderRadius: '2px',
          },
        },
      }}
    >
      <CardForm onSuccess={onSuccess} />
    </Elements>
  )
}

function CardForm({ onSuccess }: { onSuccess: () => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return

    setSaving(true)
    setError(null)

    try {
      const cardElement = elements.getElement(CardElement)
      if (!cardElement) throw new Error('Card element not found')

      // Create a PaymentMethod directly (no SetupIntent needed for off-session)
      const { error: stripeError, paymentMethod } = await stripe.createPaymentMethod({
        type: 'card',
        card: cardElement,
      })

      if (stripeError) {
        setError(stripeError.message ?? 'Card setup failed.')
        return
      }

      if (!paymentMethod) {
        setError('Card setup failed. Please try again.')
        return
      }

      // Send to gateway — this attaches the PM, creates a Stripe Customer,
      // and triggers provisional → accrued conversion
      await auth.connectCard(paymentMethod.id)

      onSuccess()
    } catch (err: any) {
      setError(err.body?.error ?? 'Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="border border-rule px-3 py-3 mb-3">
        <CardElement
          options={{
            style: {
              base: {
                fontSize: '14px',
                color: '#292524',
                '::placeholder': { color: '#a8a29e' },
              },
            },
          }}
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 mb-3">{error}</p>
      )}

      <button
        type="submit"
        disabled={saving || !stripe}
        className="btn px-6 py-2.5 text-sm font-medium disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Add card'}
      </button>

      <p className="mt-3 text-xs text-content-faint">
        Your card won't be charged now. It will be used when your reading tab
        settles (at £8 or monthly).
      </p>
    </form>
  )
}
