'use client'

import { useState } from 'react'
import { useAuth } from '../../stores/auth'
import { auth } from '../../lib/api'
import { CardSetup } from '../payment/CardSetup'

export function PaymentSection() {
  const { user, fetchMe } = useAuth()
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  if (!user) return null

  async function handleConnectStripe() {
    setConnecting(true); setConnectError(null)
    try {
      const result = await auth.connectStripe()
      window.location.href = result.stripeConnectUrl
    } catch {
      setConnectError('Failed to start Stripe setup.')
      setConnecting(false)
    }
  }

  return (
    <div className="mb-10">
      <p className="label-ui text-grey-400 mb-4">Payment &amp; payouts</p>
      <div className="bg-white divide-y divide-grey-200/50">
        {/* Card on file */}
        <div className="px-6 py-4">
          {user.hasPaymentMethod ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-ui-sm text-black">Card connected</p>
                <p className="text-ui-xs text-grey-300 mt-0.5">Your reading tab settles automatically.</p>
              </div>
              <span className="label-ui text-grey-400">Active</span>
            </div>
          ) : (
            <div>
              <p className="text-ui-sm text-black mb-2">Add a payment method</p>
              <p className="text-ui-xs text-grey-400 mb-3">Required to keep reading after your free allowance.</p>
              <CardSetup onSuccess={() => fetchMe()} />
            </div>
          )}
        </div>

        {/* Stripe Connect */}
        <div className="px-6 py-4">
          {user.stripeConnectKycComplete ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-ui-sm text-black">Stripe Connect</p>
                <p className="text-ui-xs text-grey-300 mt-0.5">Verified — payouts enabled.</p>
              </div>
              <span className="label-ui text-grey-400">Verified</span>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-ui-sm text-black">Stripe Connect</p>
                  <p className="text-ui-xs text-grey-300 mt-0.5">Connect to receive payouts.</p>
                </div>
                <button
                  onClick={handleConnectStripe}
                  disabled={connecting}
                  className="text-ui-xs text-crimson hover:text-crimson-dark underline underline-offset-4 disabled:opacity-50"
                >
                  {connecting ? 'Setting up…' : 'Set up'}
                </button>
              </div>
              {connectError && <p className="text-ui-xs text-red-600 mt-2">{connectError}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
