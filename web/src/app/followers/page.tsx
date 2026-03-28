'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'

interface Follower {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  pubkey: string
  isWriter: boolean
  followedAt: string
}

export default function FollowersPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [followers, setFollowers] = useState<Follower[]>([])
  const [dataLoading, setDataLoading] = useState(true)

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  useEffect(() => {
    if (!user) return
    fetch('/api/v1/follows/followers', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { followers: [] })
      .then(d => setFollowers(d.followers ?? []))
      .catch(() => {})
      .finally(() => setDataLoading(false))
  }, [user])

  if (loading || !user) return <PageSkeleton />

  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0 px-6 py-8">
      <h1 className="font-serif text-2xl font-normal text-content-primary mb-1">Followers</h1>
      <p className="text-ui-sm text-content-muted mb-8">
        {followers.length > 0 ? `${followers.length} ${followers.length === 1 ? 'person follows' : 'people follow'} you` : 'People who follow you'}
      </p>

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
      ) : followers.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-content-muted mb-4">No followers yet.</p>
          <p className="text-ui-xs text-content-faint">Share your writing to grow your audience.</p>
        </div>
      ) : (
        <div className="divide-y divide-rule">
          {followers.map(f => (
            <div key={f.id} className="flex items-center gap-4 py-4">
              <Link href={`/${f.username}`} className="flex-shrink-0">
                {f.avatar ? (
                  <img src={f.avatar} alt="" className="h-11 w-11 rounded-full object-cover" />
                ) : (
                  <span className="flex h-11 w-11 items-center justify-center bg-surface-deep text-sm font-medium text-content-muted rounded-full">
                    {(f.displayName ?? f.username)[0].toUpperCase()}
                  </span>
                )}
              </Link>
              <div className="flex-1 min-w-0">
                <Link href={`/${f.username}`} className="group">
                  <p className="font-serif text-base text-content-primary group-hover:opacity-75 transition-opacity truncate">
                    {f.displayName ?? f.username}
                  </p>
                  <p className="text-ui-xs text-content-muted">
                    @{f.username}
                    {f.isWriter && <span className="ml-2 text-content-faint">· writer</span>}
                  </p>
                </Link>
              </div>
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
