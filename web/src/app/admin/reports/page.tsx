'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../../stores/auth'
import { useRouter } from 'next/navigation'
import { admin as adminApi, type Report } from '../../../lib/api'
import { ReportCard } from '../../../components/admin/ReportCard'
import { PageShell } from '../../../components/ui/PageShell'

type ReportFilter = 'pending' | 'resolved' | 'all'

export default function AdminReportsPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [reports, setReports] = useState<Report[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  const [filter, setFilter] = useState<ReportFilter>('pending')

  useEffect(() => {
    if (loading) return
    if (!user || !user.isAdmin) {
      router.replace('/feed')
    }
  }, [user, loading, router])

  async function fetchReports() {
    setDataLoading(true)
    try {
      const statusParam = filter === 'all' ? undefined : filter
      const data = await adminApi.listReports(statusParam)
      setReports(data.reports)
    } catch {}
    finally { setDataLoading(false) }
  }

  useEffect(() => { if (user?.isAdmin) fetchReports() }, [user, filter])

  if (loading || !user?.isAdmin) {
    return (
      <PageShell width="feed">
        <div className="h-32 animate-pulse bg-white" />
      </PageShell>
    )
  }

  return (
    <PageShell width="feed" title="Reports">
      {/* Filter tabs */}
      <div className="flex gap-2 mb-8">
        {(['pending', 'resolved', 'all'] as ReportFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`tab-pill ${filter === f ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {dataLoading ? (
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-24 animate-pulse bg-white" />)}</div>
      ) : reports.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-400">No {filter === 'all' ? '' : filter} reports.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reports.map(r => (
            <ReportCard key={r.id} report={r} onResolved={fetchReports} />
          ))}
        </div>
      )}
    </PageShell>
  )
}
