'use client'

import { useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { auth } from '../../lib/api'
import { useAuth } from '../../stores/auth'

export default function AuthPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const setUser = useAuth((s) => s.setUser)

  const initialMode = searchParams.get('mode') === 'login' ? 'login' : 'signup'
  const [mode, setMode] = useState<'signup' | 'login'>(initialMode)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [magicLinkSent, setMagicLinkSent] = useState(false)

  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      await auth.signup({ email, displayName, username })
      const me = await auth.me()
      setUser(me)
      router.push('/feed')
    } catch (err: any) {
      if (err.body?.error === 'username_taken') {
        setError('That username is already taken.')
      } else if (err.body?.error === 'email_taken') {
        setError('An account with that email already exists. Try logging in instead.')
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

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

  if (magicLinkSent) {
    return (
      <div className="mx-auto max-w-sm px-6 py-28 text-center">
        <div className="ornament mb-8" />
        <h1 className="font-serif text-2xl font-medium text-ink mb-4 tracking-tight">
          Check your email
        </h1>
        <p className="text-mono-sm text-content-secondary leading-relaxed">
          If an account exists for <span className="text-ink">{email}</span>,
          we've sent a login link. It expires in 15 minutes.
        </p>
        <button
          onClick={() => { setMagicLinkSent(false); setEmail('') }}
          className="mt-8 text-mono-xs text-content-secondary hover:text-content-primary underline underline-offset-4 transition-colors"
        >
          Try a different email
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-sm px-6 py-28">
      <h1 className="font-serif text-2xl font-medium text-ink mb-2 tracking-tight">
        {mode === 'signup' ? 'Create your account' : 'Welcome back'}
      </h1>
      <p className="text-mono-xs text-content-secondary mb-10">
        {mode === 'signup'
          ? 'Your first £5 of reading is free. No card required.'
          : 'We\'ll send a login link to your email.'}
      </p>

      {error && (
        <div className="mb-6 bg-card px-4 py-3 text-mono-xs text-content-primary">
          {error}
        </div>
      )}

      <a
        href="/api/v1/auth/google"
        className="flex w-full items-center justify-center gap-3 bg-card px-4 py-2.5 text-mono-xs text-content-primary hover:bg-surface-deep transition-colors"
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
          <span className="bg-surface px-4 text-mono-xs text-content-muted">or</span>
        </div>
      </div>

      <form onSubmit={mode === 'signup' ? handleSignup : handleLogin} className="space-y-5">
        <div>
          <label htmlFor="email" className="label-muted block mb-2">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-card px-3 py-2.5 text-mono-sm text-content-primary focus:outline-none" placeholder="you@example.com" />
        </div>

        {mode === 'signup' && (
          <>
            <div>
              <label htmlFor="displayName" className="label-muted block mb-2">Display name</label>
              <input id="displayName" type="text" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="w-full bg-card px-3 py-2.5 text-mono-sm text-content-primary focus:outline-none" placeholder="Your Name" />
            </div>
            <div>
              <label htmlFor="username" className="label-muted block mb-2">Username</label>
              <input id="username" type="text" required pattern="^[a-z0-9_-]+$" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} className="w-full bg-card px-3 py-2.5 text-mono-sm text-content-primary focus:outline-none" placeholder="yourname" />
              <p className="mt-2 text-mono-xs text-content-muted">yourname.platform.pub</p>
            </div>
          </>
        )}

        <button type="submit" disabled={loading} className="w-full btn disabled:opacity-50 transition-colors">
          {loading ? 'Working...' : mode === 'signup' ? 'Create account' : 'Send login link'}
        </button>
      </form>

      <p className="mt-8 text-center text-mono-xs text-content-secondary">
        {mode === 'signup' ? (
          <>Already have an account?{' '}<button onClick={() => setMode('login')} className="text-ink underline underline-offset-4 hover:text-content-secondary">Log in</button></>
        ) : (
          <>New here?{' '}<button onClick={() => setMode('signup')} className="text-ink underline underline-offset-4 hover:text-content-secondary">Create an account</button></>
        )}
      </p>
    </div>
  )
}
