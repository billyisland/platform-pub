'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'

export default function AdminPage() {
  const { user, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (loading) return
    if (!user || !user.isAdmin) {
      router.replace('/feed')
    } else {
      router.replace('/admin/reports')
    }
  }, [user, loading, router])

  return (
    <div className="mx-auto max-w-content px-6 py-10">
      <p className="text-[14px] font-sans text-grey-300">Redirecting…</p>
    </div>
  )
}
