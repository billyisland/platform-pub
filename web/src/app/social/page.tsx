'use client'

import { useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { FeedDial } from '../../components/social/FeedDial'
import { BlockList } from '../../components/social/BlockList'
import { MuteList } from '../../components/social/MuteList'
import { DmFeeSettings } from '../../components/social/DmFeeSettings'
import { NotificationPreferences } from '../../components/social/NotificationPreferences'

export default function SocialPage() {
  const { user, loading } = useAuth()
  const router = useRouter()

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 py-12">
        <div className="h-6 w-32 animate-pulse bg-white mb-8" />
        <div className="space-y-6">
          {[1, 2, 3].map(i => <div key={i} className="h-24 animate-pulse bg-white" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-article px-4 sm:px-6 py-12">
      <h1 className="font-serif text-2xl font-light text-black tracking-tight mb-10">
        Social
      </h1>

      <div className="space-y-10">
        {/* Feed reach */}
        <section className="bg-white px-6 py-5">
          <FeedDial />
        </section>

        {/* Notification preferences */}
        <section className="bg-white px-6 py-5">
          <NotificationPreferences />
        </section>

        {/* Boundaries */}
        <section className="bg-white px-6 py-5">
          <BlockList />
        </section>

        <section className="bg-white px-6 py-5">
          <MuteList />
        </section>

        {/* DM access */}
        <section className="bg-white px-6 py-5">
          <DmFeeSettings />
        </section>
      </div>
    </div>
  )
}
