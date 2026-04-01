'use client'

import { useEffect } from 'react'
import { useAuth } from '../../stores/auth'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const fetchMe = useAuth((s) => s.fetchMe)
  const loading = useAuth((s) => s.loading)

  useEffect(() => {
    fetchMe()
  }, [fetchMe])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    )
  }

  return <>{children}</>
}
