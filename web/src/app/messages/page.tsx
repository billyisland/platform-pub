'use client'

import { useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { MessagesPanel } from '../../components/messages/MessagesPanel'

export default function MessagesPage() {
  const { user, loading } = useAuth()
  const router = useRouter()

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-content px-4 sm:px-6 py-10">
        <div className="h-[600px] animate-pulse bg-white" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-content px-4 sm:px-6 py-10">
      <MessagesPanel className="bg-white h-[calc(100vh-160px)] min-h-[400px]" />
    </div>
  )
}
