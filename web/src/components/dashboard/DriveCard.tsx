'use client'

import { useState } from 'react'
import { drives, type PledgeDrive } from '../../lib/api'

export function DriveCard({ drive, onUpdate }: { drive: PledgeDrive; onUpdate: () => void }) {
  const [acting, setActing] = useState(false)

  const target = drive.fundingTargetPence ?? 0
  const progressPct = target > 0
    ? Math.min(100, Math.round((drive.currentTotalPence / target) * 100))
    : 0

  async function handleCancel() {
    if (!confirm('Cancel this drive? Pledges will be released.')) return
    setActing(true)
    try { await drives.cancel(drive.id); onUpdate() }
    catch { alert('Failed to cancel drive.') }
    finally { setActing(false) }
  }

  async function handlePin() {
    setActing(true)
    try { await drives.togglePin(drive.id); onUpdate() }
    catch { alert('Failed to update pin.') }
    finally { setActing(false) }
  }

  const isActive = drive.status === 'open' || drive.status === 'funded'

  return (
    <div className="bg-white px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-grey-300">
              Pledge drive
            </span>
            {drive.pinned && (
              <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-crimson">Pinned</span>
            )}
            <span className={`font-mono text-[12px] uppercase tracking-[0.06em] ${
              drive.status === 'funded' ? 'text-black' : drive.status === 'cancelled' ? 'text-grey-300' : 'text-grey-400'
            }`}>
              {drive.status}
            </span>
          </div>
          <p className="font-serif text-lg font-medium text-black">{drive.title}</p>
          {drive.description && (
            <p className="text-[14px] text-grey-600 font-sans mt-1 line-clamp-2">{drive.description}</p>
          )}
        </div>

        <div className="text-right flex-shrink-0">
          <p className="font-serif text-lg text-black">
            £{(drive.currentTotalPence / 100).toFixed(2)}
          </p>
          {target > 0 && (
            <p className="font-mono text-[12px] text-grey-300 uppercase tracking-[0.06em]">
              of £{(target / 100).toFixed(2)}
            </p>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {target > 0 && (
        <div className="mt-3 h-1.5 bg-grey-100 w-full">
          <div
            className="h-full bg-crimson transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
      <p className="font-mono text-[12px] text-grey-300 mt-1 uppercase tracking-[0.06em]">
        {target > 0 ? `${progressPct}% · ` : ''}{drive.pledgeCount} {drive.pledgeCount === 1 ? 'pledge' : 'pledges'}
      </p>

      {/* Actions */}
      {isActive && (
        <div className="mt-4 flex items-center gap-3">
          <button onClick={handlePin} disabled={acting} className="text-[13px] font-sans text-grey-400 hover:text-black disabled:opacity-50">
            {drive.pinned ? 'Unpin' : 'Pin to profile'}
          </button>
          <button onClick={handleCancel} disabled={acting} className="text-[13px] font-sans text-grey-300 hover:text-black disabled:opacity-50">
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
