'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useAuth } from '../../../stores/auth'
import { tributesEnabled } from '../../../lib/api'
import { TRIBUTE_CLAIM_KEY } from '../../../components/tribute/TributeClaimResumer'
import { ForAllMark } from '../../../components/icons/ForAllMark'

// =============================================================================
// /tribute/claim?token=… — the landing for an external tribute-offer email.
//
// The token is stashed in sessionStorage, then the global TributeClaimResumer
// (mounted in LayoutShell) redeems it as soon as auth resolves — so the claim
// survives the signup round-trip. This page only routes: a logged-in invitee is
// claimed in place (the resumer redirects to the piece); an anonymous one is
// invited to create a free account, after which the resumer fires on /reader.
// =============================================================================

function ClaimInner() {
  const params = useSearchParams()
  const router = useRouter()
  const { user, loading } = useAuth()
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    const t = params.get('token')
    if (!t) return
    setToken(t)
    try { sessionStorage.setItem(TRIBUTE_CLAIM_KEY, t) } catch { /* ignore */ }
    // Strip the token from the URL once stashed — it binds money to an account,
    // so it must not linger in browser history, server access logs, or Referer.
    router.replace('/tribute/claim')
  }, [params, router])

  if (!tributesEnabled()) {
    return <Card title="Not available">This feature isn’t available right now.</Card>
  }
  if (!token) {
    return <Card title="Missing link">This claim link is incomplete. Please use the link from your email.</Card>
  }
  if (loading) {
    return <Card title="One moment…">Checking your session…</Card>
  }
  if (user) {
    // The resumer claims the stashed token and redirects to the piece.
    return <Card title="Claiming your tribute…">Taking you to the piece you inspired.</Card>
  }

  // Anonymous external invitee. Account creation is closed during the beta
  // (CLOSED-BETA-ADR §IV) — this feature is itself dark, but keep the CTA
  // honest: join the waiting list rather than a signup form that no longer
  // exists. Existing members can still log in and bind the offer.
  return (
    <Card title="Someone wants to share their earnings with you">
      <p className="mb-6">
        A writer on all.haus has credited you as an inspiration for a piece and offered you a share
        of what it earns. all.haus is in closed beta — join the waiting list and we’ll be in touch.
      </p>
      <button className="btn w-full" onClick={() => router.push('/waitlist')}>
        Join the waiting list
      </button>
      <p className="mt-4 text-mono-xs text-grey-600">
        Already on all.haus?{' '}
        <button
          className="text-black underline underline-offset-4 hover:text-grey-600"
          onClick={() => router.push('/auth?mode=login')}
        >
          Log in
        </button>{' '}
        and we’ll bind the offer to your account.
      </p>
    </Card>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-sm px-4 sm:px-6 py-28">
      <div className="flex justify-center mb-8">
        <ForAllMark size={28} className="text-grey-300" />
      </div>
      <h1 className="text-2xl font-medium text-black mb-4 tracking-tight">{title}</h1>
      <div className="text-ui-sm text-grey-600 leading-relaxed">{children}</div>
    </div>
  )
}

export default function TributeClaimPage() {
  return (
    <Suspense fallback={null}>
      <ClaimInner />
    </Suspense>
  )
}
