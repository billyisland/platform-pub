'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '../../../stores/auth'
import { publications as pubApi, type PublicationInvite } from '../../../lib/api'

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>()
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [invite, setInvite] = useState<PublicationInvite | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    if (!token) return
    pubApi.getInvite(token)
      .then(setInvite)
      .catch(() => setError('Invite not found or expired.'))
      .finally(() => setLoading(false))
  }, [token])

  async function handleAccept() {
    if (!invite || !user) return
    setAccepting(true)
    setError(null)
    try {
      // We need the publication ID — fetch it from the invite's slug
      const pub = await pubApi.get(invite.publication_slug)
      await pubApi.acceptInvite(pub.id, token)
      setAccepted(true)
      setTimeout(() => {
        router.push(`/reader?overlay=dashboard&context=${invite.publication_slug}`)
      }, 1500)
    } catch {
      setError('Failed to accept invite.')
    } finally {
      setAccepting(false)
    }
  }

  if (loading || authLoading) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-grey-100" />
      </div>
    )
  }

  if (error && !invite) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 text-center">
        <p className="text-grey-600 mb-4">{error}</p>
        <Link href="/" className="text-sm text-crimson hover:text-crimson-dark">
          Go home
        </Link>
      </div>
    )
  }

  if (!invite) return null

  return (
    <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16">
      <div className="bg-white px-8 py-10 text-center">
        {invite.publication_logo && (
          <img src={invite.publication_logo} alt="" className="w-16 h-16 rounded-full mx-auto mb-4 object-cover" />
        )}
        <h1 className="font-serif text-2xl text-black mb-2">
          Join {invite.publication_name}
        </h1>
        <p className="text-grey-600 text-sm mb-1">
          {invite.inviter_name} invited you as <strong>{invite.role.replace('_', ' ')}</strong>
        </p>
        {invite.message && (
          <p className="text-grey-400 text-sm italic mt-3 mb-6">
            &ldquo;{invite.message}&rdquo;
          </p>
        )}

        {accepted ? (
          <p className="text-sm text-black mt-6">
            Welcome! Redirecting to the dashboard...
          </p>
        ) : user ? (
          <div className="mt-8 flex items-center justify-center gap-4">
            <button
              onClick={handleAccept}
              disabled={accepting}
              className="btn disabled:opacity-50"
            >
              {accepting ? 'Accepting...' : 'Accept'}
            </button>
            <Link href="/" className="text-sm text-grey-400 hover:text-black">
              Decline
            </Link>
          </div>
        ) : (
          <div className="mt-8">
            {/* Closed beta (CLOSED-BETA-ADR §IV, §VIII open item): account
                creation is closed, so during the beta a masthead recruits only
                existing members — an invitee logs in to accept. A token-scoped
                signup exemption for outside writers is a deferred design call. */}
            <p className="text-sm text-grey-600 mb-4">
              Log in to accept this invitation.
            </p>
            <Link
              href={`/auth?mode=login&redirect=/invite/${token}`}
              className="btn"
            >
              Log in to accept
            </Link>
          </div>
        )}

        {error && <p className="text-sm text-red-600 mt-4">{error}</p>}
      </div>
    </div>
  )
}
