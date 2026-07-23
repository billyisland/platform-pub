'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useAuth } from '../../../../stores/auth'

// =============================================================================
// Google OAuth callback page
//
// Google redirects here after the user approves (or denies) consent.
// We POST the code + state to the gateway exchange endpoint, which validates
// the state cookie, exchanges the code, and sets the session cookie in its
// response. We then call /auth/me to hydrate the store and navigate to /feed.
//
// Doing the exchange via a regular fetch (not a gateway redirect) ensures
// Set-Cookie is in a normal response body, not a redirect — Next.js rewrite
// proxies reliably forward cookies in regular responses.
// =============================================================================

export default function GoogleCallbackPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const fetchMe = useAuth((s) => s.fetchMe)
  const called = useRef(false)

  useEffect(() => {
    if (called.current) return
    called.current = true

    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    if (error || !code || !state) {
      router.replace('/auth?mode=login&error=google_denied')
      return
    }

    fetch('/api/v1/auth/google/exchange', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    })
      .then(async (res) => {
        if (!res.ok) {
          // Closed beta: this Google email has no account and the gateway
          // refused to create one (CLOSED-BETA-ADR D1). That is a normal
          // outcome, not a failure — route to the explanation rather than the
          // generic error, which would read as "something broke".
          const body = await res.json().catch(() => null)
          if (body?.error === 'closed_beta') {
            router.replace('/auth?mode=login&error=closed_beta')
            return
          }
          throw new Error('Exchange failed')
        }
        await fetchMe()
        router.replace('/reader')
      })
      .catch(() => {
        router.replace('/auth?mode=login&error=google_failed')
      })
  }, [])  

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-mono-xs text-grey-600">Signing in…</p>
    </div>
  )
}
