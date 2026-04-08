'use client'

import { useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'

const POLL_INTERVAL = 15_000

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const fetchMe = useAuth((s) => s.fetchMe)
  const user = useAuth((s) => s.user)
  const fetchUnread = useUnreadCounts((s) => s.fetch)

  useEffect(() => {
    fetchMe()
  }, [fetchMe])

  useEffect(() => {
    if (!user) return
    fetchUnread()
    const id = setInterval(fetchUnread, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [user, fetchUnread])

  return <>{children}</>
}
