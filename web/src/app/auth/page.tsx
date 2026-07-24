'use client'

import { useState, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { auth } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { ForAllMark } from '../../components/icons/ForAllMark'

// Closed beta (CLOSED-BETA-ADR Phase 3, D4). `/auth` is now login-only: the
// signup form and the login/signup toggle are gone (account creation is closed
// server-side — D1). Two edge cases route to the waitlist surface instead of
// showing a raw error here:
//   (a) a visitor arriving directly at `/auth?mode=signup`, and
//   (b) a new Google email the gateway refused (the callback lands us with
//       `?error=closed_beta`).
// Both mean "no account, and none can be made" — the waitlist is the answer.
export default function AuthPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const setUser = useAuth((s) => s.setUser)

  const wantsSignup = searchParams.get('mode') === 'signup'
  const initialError = searchParams.get('error')
  const redirectingToWaitlist = wantsSignup || initialError === 'closed_beta'

  useEffect(() => {
    if (redirectingToWaitlist) router.replace('/waitlist?from=beta')
  }, [redirectingToWaitlist, router])

  // The Google callback page routes failures back here as ?error=<code>.
  const [error, setError] = useState<string | null>(
    initialError === 'google_denied'
      ? 'Google sign-in was cancelled.'
      : initialError === 'google_failed'
        ? 'Google sign-in didn\'t complete. Please try again.'
        : null,
  )
  const [loading, setLoading] = useState(false)
  const [magicLinkSent, setMagicLinkSent] = useState(false)
  const [email, setEmail] = useState('')

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      await auth.login(email)
      setMagicLinkSent(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDevLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      await auth.devLogin(email)
      const me = await auth.me()
      setUser(me)
      router.push('/reader')
    } catch {
      setError('Dev login failed — is that email in the database?')
    } finally {
      setLoading(false)
    }
  }

  // Redirecting to the waitlist — render nothing so the login form never flashes.
  if (redirectingToWaitlist) return null

  if (magicLinkSent) {
    return (
      <div className="mx-auto max-w-sm px-4 sm:px-6 py-28 text-center">
        <div className="flex justify-center mb-8">
          <ForAllMark size={28} className="text-grey-300" />
        </div>
        <h1 className="font-serif text-2xl font-medium text-black mb-4 tracking-tight">
          Check your email
        </h1>
        <p className="text-mono-sm text-grey-600 leading-relaxed">
          If an account exists for <span className="text-black">{email}</span>,
          we've sent a login link. It expires in 15 minutes.
        </p>
        <button
          onClick={() => { setMagicLinkSent(false); setEmail('') }}
          className="mt-8 text-mono-xs text-grey-600 hover:text-black underline underline-offset-4 transition-colors"
        >
          Try a different email
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-sm px-4 sm:px-6 py-28">
      <h1 className="font-serif font-medium text-black mb-2 tracking-tight" style={{ fontSize: '28px' }}>
        Welcome back
      </h1>
      <p className="text-mono-xs text-grey-600 mb-10">
        We&apos;ll send a login link to your email.
      </p>

      {error && (
        <div className="mb-6 bg-white px-4 py-3 text-mono-xs text-black">
          {error}
        </div>
      )}

      <a
        href="/api/v1/auth/google"
        className="flex w-full items-center justify-center gap-3 bg-white px-4 py-[14px] text-mono-xs text-black hover:bg-grey-100 transition-colors"
        style={{ border: '1.5px solid var(--ah-grey-200)' }}
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Continue with Google
      </a>

      <div className="relative my-8">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full rule" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-white px-4 text-mono-xs text-grey-400">or</span>
        </div>
      </div>

      <form onSubmit={handleLogin} className="space-y-5">
        <div>
          <label htmlFor="email" className="label-ui text-grey-400 block mb-2">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-white px-4 py-[14px] text-black focus:outline-none" style={{ fontSize: '16px', border: '1.5px solid var(--ah-grey-200)' }} placeholder="you@example.com" />
        </div>

        <button type="submit" disabled={loading} className="w-full btn disabled:opacity-50 transition-colors">
          {loading ? 'Working...' : 'Send login link'}
        </button>
      </form>

      <p className="mt-8 text-center text-mono-xs text-grey-600">
        New here?{' '}
        <Link href="/waitlist" className="text-black underline underline-offset-4 hover:text-grey-600">
          Join the waiting list
        </Link>
      </p>

      {process.env.NODE_ENV === 'development' && (
        <div className="mt-10 pt-6" style={{ borderTop: '1.5px dashed var(--ah-grey-200)' }}>
          <p className="text-mono-xs text-grey-400 mb-3">Dev mode</p>
          <button
            onClick={handleDevLogin}
            disabled={loading || !email}
            className="w-full bg-grey-100 px-4 py-[14px] text-mono-xs text-grey-600 hover:text-black disabled:opacity-50 transition-colors"
            style={{ border: '1.5px dashed var(--ah-grey-200)' }}
          >
            {loading ? 'Working...' : 'Instant dev login (skip magic link)'}
          </button>
        </div>
      )}
    </div>
  )
}
