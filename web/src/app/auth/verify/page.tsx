'use client'

import { useState, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { auth } from '../../../lib/api'
import { useAuth } from '../../../stores/auth'

// =============================================================================
// Magic Link Verification Page
//
// URL: /auth/verify?token=<token>
//
// The email magic link points here. On mount:
//   1. Extract token from URL
//   2. POST /auth/verify with the token
//   3. If valid: session cookie set, redirect to /feed
//   4. If invalid/expired: show error with retry option
// =============================================================================

export default function VerifyPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { fetchMe } = useAuth()
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying')
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) {
      setStatus('error')
      setErrorMessage('No login token found in the URL.')
      return
    }

    async function verify() {
      try {
        await auth.verify(token!)
        setStatus('success')
        // Hydrate auth store with the new session
        await fetchMe()
        // Short delay so the success message is visible
        setTimeout(() => router.push('/feed'), 800)
      } catch (err: any) {
        setStatus('error')
        if (err.status === 401) {
          setErrorMessage('This login link has expired or already been used.')
        } else {
          setErrorMessage('Something went wrong. Please try again.')
        }
      }
    }

    verify()
  }, [searchParams, router, fetchMe])

  return (
    <div className="mx-auto max-w-sm px-6 py-24 text-center">
      {status === 'verifying' && (
        <>
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-rule border-t-ink" />
          <h1 className="font-serif text-xl font-bold text-ink mb-2">
            Logging you in...
          </h1>
          <p className="text-sm text-content-muted">Verifying your login link.</p>
        </>
      )}

      {status === 'success' && (
        <>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="font-serif text-xl font-bold text-ink mb-2">
            You're in
          </h1>
          <p className="text-sm text-content-muted">Redirecting to your feed...</p>
        </>
      )}

      {status === 'error' && (
        <>
          <h1 className="font-serif text-xl font-bold text-ink mb-2">
            Login link didn't work
          </h1>
          <p className="text-sm text-content-muted mb-6 leading-relaxed">
            {errorMessage}
          </p>
          <a
            href="/auth?mode=login"
            className="btn px-6 py-2.5 text-sm font-medium inline-block"
          >
            Request a new link
          </a>
        </>
      )}
    </div>
  )
}
