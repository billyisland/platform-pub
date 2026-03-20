'use client'

import { useEffect } from 'react'
import { useAuth } from '../../stores/auth'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const fetchMe = useAuth((s) => s.fetchMe)

  useEffect(() => {
    fetchMe()
  }, [fetchMe])

  return <>{children}</>
}
