'use client'

import Link from 'next/link'
import { useAuth } from '../../stores/auth'
import { CardSetup } from '../payment/CardSetup'

export function PaymentSection() {
  const { user, fetchMe } = useAuth()
  if (!user) return null

  return (
    <div className="mb-10">
      <p className="label-ui text-grey-400 mb-4">Payment &amp; payouts</p>
      <div className="bg-white divide-y divide-grey-200/50">
        {/* Card on file */}
        <div className="px-6 py-4">
          {user.hasPaymentMethod ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-sans text-black">Card connected</p>
                <p className="text-[13px] font-sans text-grey-300 mt-0.5">Your reading tab settles automatically.</p>
              </div>
              <span className="font-mono text-[12px] text-grey-400 uppercase tracking-[0.06em]">Active</span>
            </div>
          ) : (
            <div>
              <p className="text-[14px] font-sans text-black mb-2">Add a payment method</p>
              <p className="text-[13px] font-sans text-grey-400 mb-3">Required to keep reading after your free allowance.</p>
              <CardSetup onSuccess={() => fetchMe()} />
            </div>
          )}
        </div>

        {/* Stripe Connect */}
        <div className="px-6 py-4">
          {user.stripeConnectKycComplete ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-sans text-black">Stripe Connect</p>
                <p className="text-[13px] font-sans text-grey-300 mt-0.5">Verified — payouts enabled.</p>
              </div>
              <span className="font-mono text-[12px] text-grey-400 uppercase tracking-[0.06em]">Verified</span>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-sans text-black">Stripe Connect</p>
                <p className="text-[13px] font-sans text-grey-300 mt-0.5">Connect to receive payouts.</p>
              </div>
              <Link href="/settings" className="text-[13px] font-sans text-crimson hover:text-crimson-dark underline underline-offset-4">
                Set up
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
