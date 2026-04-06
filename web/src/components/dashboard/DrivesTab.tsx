'use client'

import { useState, useEffect } from 'react'
import { drives as drivesApi, type PledgeDrive } from '../../lib/api'
import { DriveCard } from './DriveCard'
import { DriveCreateForm } from './DriveCreateForm'

export function DrivesTab({ userId }: { userId: string }) {
  const [allDrives, setAllDrives] = useState<PledgeDrive[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  async function fetchDrives() {
    setLoading(true)
    try {
      const data = await drivesApi.listByUser(userId)
      setAllDrives(data.drives)
    } catch {
      setError('Failed to load drives.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchDrives() }, [userId])

  function handleCreated() {
    setShowCreate(false)
    fetchDrives()
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map(i => <div key={i} className="h-24 animate-pulse bg-white" />)}
      </div>
    )
  }

  if (error) return <div className="bg-white px-4 py-3 text-ui-xs text-black">{error}</div>

  const active = allDrives.filter(d => d.status === 'open' || d.status === 'funded')
  const completed = allDrives.filter(d => d.status !== 'open' && d.status !== 'funded')

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div />
        {!showCreate && (
          <button onClick={() => setShowCreate(true)} className="btn text-sm">
            New pledge drive
          </button>
        )}
      </div>

      {showCreate && (
        <div className="mb-8">
          <DriveCreateForm onCreated={handleCreated} onCancel={() => setShowCreate(false)} />
        </div>
      )}

      {/* Active drives */}
      {active.length > 0 && (
        <div className="mb-8">
          <p className="label-ui text-grey-400 mb-4">Active pledge drives</p>
          <div className="space-y-2">
            {active.map(d => <DriveCard key={d.id} drive={d} onUpdate={fetchDrives} />)}
          </div>
        </div>
      )}

      {/* Completed / cancelled */}
      {completed.length > 0 && (
        <div className="mb-8">
          <p className="label-ui text-grey-400 mb-4">Completed &amp; cancelled</p>
          <div className="space-y-2">
            {completed.map(d => <DriveCard key={d.id} drive={d} onUpdate={fetchDrives} />)}
          </div>
        </div>
      )}

      {allDrives.length === 0 && !showCreate && (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-400 mb-4">No pledge drives yet.</p>
          <button onClick={() => setShowCreate(true)} className="text-ui-xs text-black underline underline-offset-4">
            Create your first pledge drive
          </button>
        </div>
      )}
    </div>
  )
}
