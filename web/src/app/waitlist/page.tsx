'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { waitlist } from '../../lib/api'
import { ForAllMark } from '../../components/icons/ForAllMark'

// Closed-beta waiting-list surface (CLOSED-BETA-ADR Phase 2, D2/D3/D4).
// Readers-first: everyone joins as a user by default; "I'd also like to
// publish" is the single soft opt-in (D3). The endpoint is enumeration-safe,
// so every success looks identical — we never say whether the email was new.
export default function WaitlistPage() {
  const [email, setEmail] = useState('')
  const [publishInterest, setPublishInterest] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)
  // Arrived here from a rejected signup / Google sign-in (D4 edge cases) — show
  // the §V "you're not in the beta yet" line. Read from location rather than
  // useSearchParams so the page needn't be wrapped in a Suspense boundary.
  const [fromBeta, setFromBeta] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('from') === 'beta') setFromBeta(true)
  }, [])

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      await waitlist.join({ email, publishInterest })
      setJoined(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (joined) {
    return (
      <div className="mx-auto max-w-sm px-4 sm:px-6 py-28 text-center">
        <div className="flex justify-center mb-8">
          <ForAllMark size={28} className="text-grey-300" />
        </div>
        <h1 className="font-serif text-2xl font-medium text-black mb-4 tracking-tight">
          You&apos;re on the list.
        </h1>
        <p className="text-mono-sm text-grey-600 leading-relaxed">
          We&apos;ll write to <span className="text-black">{email}</span> when
          there&apos;s room.
        </p>
        <p className="mt-8 text-center text-mono-xs text-grey-600">
          Already have an account?{' '}
          <Link
            href="/auth?mode=login"
            className="text-black underline underline-offset-4 hover:text-grey-600"
          >
            Log in
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-sm px-4 sm:px-6 py-28">
      <h1
        className="font-serif font-medium text-black mb-2 tracking-tight"
        style={{ fontSize: '28px' }}
      >
        Not open yet.
      </h1>
      <p className="text-mono-xs text-grey-600 mb-10 leading-relaxed">
        {fromBeta
          ? 'You’re not in the beta yet. Join the waiting list and we’ll be in touch when there’s room.'
          : 'all.haus is in closed beta. Join the list and we’ll write when there’s room.'}
      </p>

      {error && (
        <div className="mb-6 bg-white px-4 py-3 text-mono-xs text-black">
          {error}
        </div>
      )}

      <form onSubmit={handleJoin} className="space-y-5">
        <div>
          <label htmlFor="email" className="label-ui text-grey-400 block mb-2">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-white px-4 py-[14px] text-black focus:outline-none"
            style={{ fontSize: '16px', border: '1.5px solid var(--ah-grey-200)' }}
            placeholder="you@example.com"
          />
        </div>

        <label
          htmlFor="publishInterest"
          className="flex items-start gap-3 cursor-pointer select-none"
        >
          <input
            id="publishInterest"
            type="checkbox"
            checked={publishInterest}
            onChange={(e) => setPublishInterest(e.target.checked)}
            className="mt-[2px] h-4 w-4 shrink-0 accent-crimson cursor-pointer"
          />
          <span className="text-mono-xs text-grey-600 leading-relaxed">
            I&apos;d also like to publish
          </span>
        </label>

        <button
          type="submit"
          disabled={loading}
          className="w-full btn disabled:opacity-50 transition-colors"
        >
          {loading ? 'Working...' : 'Join the list'}
        </button>
      </form>

      <p className="mt-8 text-center text-mono-xs text-grey-600">
        Already have an account?{' '}
        <Link
          href="/auth?mode=login"
          className="text-black underline underline-offset-4 hover:text-grey-600"
        >
          Log in
        </Link>
      </p>
    </div>
  )
}
