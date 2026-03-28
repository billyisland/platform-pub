'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'

interface Writer {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  pubkey: string
  followedAt: string
}

export default function FollowingPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [writers, setWriters] = useState<Writer[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  const [unfollowing, setUnfollowing] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  useEffect(() => {
    if (!user) return
    fetch('/api/v1/follows', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { writers: [] })
      .then(d => setWriters(d.writers ?? []))
      .catch(() => {})
      .finally(() => setDataLoading(false))
  }, [user])

  async function handleUnfollow(writerId: string) {
    setUnfollowing(prev => new Set([...prev, writerId]))
    try {
      const res = await fetch(`/api/v1/follows/${writerId}`, { method: 'DELETE', credentials: 'include' })
      if (res.ok) {
        setWriters(prev => prev.filter(w => w.id !== writerId))
      }
    } catch { /* ignore */ } finally {
      setUnfollowing(prev => { const s = new Set(prev); s.delete(writerId); return s })
    }
  }

  if (loading || !user) return <PageSkeleton />

  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0 px-6 py-8">
      <h1 className="font-serif text-2xl font-normal text-content-primary mb-1">Following</h1>
      <p className="text-ui-sm text-content-muted mb-8">Writers you follow</p>

      {dataLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex items-center gap-4 py-4 border-b border-rule animate-pulse">
              <div className="h-11 w-11 rounded-full bg-surface-deep flex-shrink-0" />
              <div className="flex-1">
                <div className="h-3.5 w-32 bg-surface-deep mb-2 rounded" />
                <div className="h-3 w-20 bg-surface-deep rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : writers.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-content-muted mb-4">You're not following anyone yet.</p>
          <Link href="/feed" className="btn py-2 px-5 text-ui-sm">Discover writers</Link>
        </div>
      ) : (
        <div className="divide-y divide-rule">
          {writers.map(w => (
            <div key={w.id} className="flex items-center gap-4 py-4">
              <Link href={`/${w.username}`} className="flex-shrink-0">
                {w.avatar ? (
                  <img src={w.avatar} alt="" className="h-11 w-11 rounded-full object-cover" />
                ) : (
                  <span className="flex h-11 w-11 items-center justify-center bg-surface-deep text-sm font-medium text-content-muted rounded-full">
                    {(w.displayName ?? w.username)[0].toUpperCase()}
                  </span>
                )}
              </Link>
              <div className="flex-1 min-w-0">
                <Link href={`/${w.username}`} className="group">
                  <p className="font-serif text-base text-content-primary group-hover:opacity-75 transition-opacity truncate">
                    {w.displayName ?? w.username}
                  </p>
                  <p className="text-ui-xs text-content-muted">@{w.username}</p>
                </Link>
              </div>
              <button
                onClick={() => handleUnfollow(w.id)}
                disabled={unfollowing.has(w.id)}
                className="btn-soft py-1.5 px-4 text-ui-xs flex-shrink-0 disabled:opacity-40"
              >
                {unfollowing.has(w.id) ? '...' : 'Unfollow'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PageSkeleton() {
  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0 px-6 py-8">
      <div className="h-7 w-36 animate-pulse bg-surface-deep mb-2 rounded" />
      <div className="h-4 w-48 animate-pulse bg-surface-deep mb-8 rounded" />
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex items-center gap-4 py-4 border-b border-rule">
            <div className="h-11 w-11 rounded-full bg-surface-deep flex-shrink-0" />
            <div className="flex-1">
              <div className="h-3.5 w-32 bg-surface-deep mb-2 rounded" />
              <div className="h-3 w-20 bg-surface-deep rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
