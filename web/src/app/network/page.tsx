'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { FeedDial } from '../../components/social/FeedDial'
import { DmFeeSettings } from '../../components/social/DmFeeSettings'
import { BlockList } from '../../components/social/BlockList'
import { MuteList } from '../../components/social/MuteList'

interface Writer {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  pubkey: string
  followedAt: string
}

interface Follower {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  pubkey: string
  isWriter: boolean
  followedAt: string
}

type NetworkTab = 'following' | 'followers' | 'blocked' | 'muted'

export default function NetworkPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialTab = (searchParams.get('tab') as NetworkTab) || 'following'
  const [tab, setTab] = useState<NetworkTab>(
    ['following', 'followers', 'blocked', 'muted'].includes(initialTab) ? initialTab : 'following'
  )

  const [writers, setWriters] = useState<Writer[]>([])
  const [followers, setFollowers] = useState<Follower[]>([])
  const [writersLoading, setWritersLoading] = useState(true)
  const [followersLoading, setFollowersLoading] = useState(true)
  const [unfollowing, setUnfollowing] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!loading && !user) router.push('/auth?mode=login')
  }, [user, loading, router])

  useEffect(() => {
    if (!user) return
    fetch('/api/v1/follows', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { writers: [] })
      .then(d => setWriters(d.writers ?? []))
      .catch(err => console.error('Failed to load followed writers', err))
      .finally(() => setWritersLoading(false))

    fetch('/api/v1/follows/followers', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { followers: [] })
      .then(d => setFollowers(d.followers ?? []))
      .catch(err => console.error('Failed to load followers', err))
      .finally(() => setFollowersLoading(false))
  }, [user])

  function switchTab(t: NetworkTab) {
    setTab(t)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', t)
    window.history.replaceState({}, '', url.toString())
  }

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

  const tabs: NetworkTab[] = ['following', 'followers', 'blocked', 'muted']

  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0 px-4 sm:px-6 py-8">
      <h1 className="font-sans text-2xl font-medium text-black tracking-tight mb-6">Network</h1>

      {/* Always-visible settings */}
      <div className="space-y-6 mb-10">
        <section className="bg-white px-6 py-5">
          <FeedDial />
        </section>
        <section className="bg-white px-6 py-5">
          <DmFeeSettings />
        </section>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-8">
        {tabs.map(t => {
          let label = t.charAt(0).toUpperCase() + t.slice(1)
          if (t === 'following' && !writersLoading) label += ` (${writers.length})`
          if (t === 'followers' && !followersLoading) label += ` (${followers.length})`
          return (
            <button
              key={t}
              onClick={() => switchTab(t)}
              className={`tab-pill ${tab === t ? 'tab-pill-active' : 'tab-pill-inactive'}`}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* Following tab */}
      {tab === 'following' && (
        writersLoading ? (
          <ListSkeleton />
        ) : writers.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-ui-sm text-grey-400 mb-4">You're not following anyone yet.</p>
            <Link href="/feed" className="btn py-2 px-5 text-ui-sm">Discover writers</Link>
          </div>
        ) : (
          <div className="space-y-1">
            {writers.map(w => (
              <div key={w.id} className="flex items-center gap-4 py-4">
                <Link href={`/${w.username}`} className="flex-shrink-0">
                  {w.avatar ? (
                    <img src={w.avatar} alt="" className="h-11 w-11  object-cover" />
                  ) : (
                    <span className="flex h-11 w-11 items-center justify-center bg-grey-100 text-sm font-medium text-grey-400 ">
                      {(w.displayName ?? w.username)[0].toUpperCase()}
                    </span>
                  )}
                </Link>
                <div className="flex-1 min-w-0">
                  <Link href={`/${w.username}`} className="group">
                    <p className="font-sans text-base font-medium text-black group-hover:opacity-75 transition-opacity truncate">
                      {w.displayName ?? w.username}
                    </p>
                    <p className="text-ui-xs text-grey-400">@{w.username}</p>
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
        )
      )}

      {/* Followers tab */}
      {tab === 'followers' && (
        followersLoading ? (
          <ListSkeleton />
        ) : followers.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-ui-sm text-grey-400 mb-4">No followers yet.</p>
            <p className="text-ui-xs text-grey-300">Share your writing to grow your audience.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {followers.map(f => (
              <div key={f.id} className="flex items-center gap-4 py-4">
                <Link href={`/${f.username}`} className="flex-shrink-0">
                  {f.avatar ? (
                    <img src={f.avatar} alt="" className="h-11 w-11  object-cover" />
                  ) : (
                    <span className="flex h-11 w-11 items-center justify-center bg-grey-100 text-sm font-medium text-grey-400 ">
                      {(f.displayName ?? f.username)[0].toUpperCase()}
                    </span>
                  )}
                </Link>
                <div className="flex-1 min-w-0">
                  <Link href={`/${f.username}`} className="group">
                    <p className="font-sans text-base font-medium text-black group-hover:opacity-75 transition-opacity truncate">
                      {f.displayName ?? f.username}
                    </p>
                    <p className="text-ui-xs text-grey-400">
                      @{f.username}
                      {f.isWriter && <span className="ml-2 text-grey-300">· writer</span>}
                    </p>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Blocked tab */}
      {tab === 'blocked' && (
        <section className="bg-white px-6 py-5">
          <BlockList />
        </section>
      )}

      {/* Muted tab */}
      {tab === 'muted' && (
        <section className="bg-white px-6 py-5">
          <MuteList />
        </section>
      )}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map(i => (
        <div key={i} className="flex items-center gap-4 py-4 mb-1 animate-pulse">
          <div className="h-11 w-11  bg-grey-100 flex-shrink-0" />
          <div className="flex-1">
            <div className="h-3.5 w-32 bg-grey-100 mb-2 rounded" />
            <div className="h-3 w-20 bg-grey-100 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

function PageSkeleton() {
  return (
    <div className="mx-auto max-w-article pt-16 lg:pt-0 px-4 sm:px-6 py-8">
      <div className="h-7 w-36 animate-pulse bg-grey-100 mb-6 rounded" />
      <div className="flex gap-2 mb-8">
        {[1, 2, 3, 4].map(i => <div key={i} className="h-9 w-24 animate-pulse bg-white" />)}
      </div>
      <ListSkeleton />
    </div>
  )
}
