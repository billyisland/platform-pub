'use client'

import { useState } from 'react'
import { drives, type PledgeDrive } from '../../lib/api'

export function DriveCard({ drive, onUpdate }: { drive: PledgeDrive; onUpdate: () => void }) {
  const [acting, setActing] = useState(false)
  const progressPct = drive.targetAmountPence > 0
    ? Math.min(100, Math.round((drive.currentAmountPence / drive.targetAmountPence) * 100))
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

  async function handleAccept() {
    setActing(true)
    try { await drives.accept(drive.id); onUpdate() }
    catch { alert('Failed to accept commission.') }
    finally { setActing(false) }
  }

  async function handleDecline() {
    setActing(true)
    try { await drives.decline(drive.id); onUpdate() }
    catch { alert('Failed to decline commission.') }
    finally { setActing(false) }
  }

  const isActive = drive.status === 'active'
  const isCommission = drive.type === 'commission'

  return (
    <div className="bg-white px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-300">
              {isCommission ? 'Commission' : 'Crowdfund'}
            </span>
            {drive.pinnedOnProfile && (
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-crimson">Pinned</span>
            )}
            <span className={`font-mono text-[11px] uppercase tracking-[0.06em] ${
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
            £{(drive.currentAmountPence / 100).toFixed(2)}
          </p>
          <p className="font-mono text-[11px] text-grey-300 uppercase tracking-[0.06em]">
            of £{(drive.targetAmountPence / 100).toFixed(2)}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1.5 bg-grey-100 w-full">
        <div
          className="h-full bg-crimson transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <p className="font-mono text-[11px] text-grey-300 mt-1 uppercase tracking-[0.06em]">
        {progressPct}% · {drive.pledgeCount} {drive.pledgeCount === 1 ? 'pledge' : 'pledges'}
      </p>

      {/* Actions */}
      {isActive && (
        <div className="mt-4 flex items-center gap-3">
          <button onClick={handlePin} disabled={acting} className="text-[13px] font-sans text-grey-400 hover:text-black disabled:opacity-50">
            {drive.pinnedOnProfile ? 'Unpin' : 'Pin to profile'}
          </button>
          <button onClick={handleCancel} disabled={acting} className="text-[13px] font-sans text-grey-300 hover:text-black disabled:opacity-50">
            Cancel
          </button>
        </div>
      )}

      {/* Commission accept/decline — only when it's a pending commission */}
      {isCommission && isActive && drive.currentAmountPence === 0 && (
        <div className="mt-4 flex items-center gap-3 border-t border-grey-200 pt-4">
          <button onClick={handleAccept} disabled={acting} className="btn text-sm disabled:opacity-50">
            Accept commission
          </button>
          <button onClick={handleDecline} disabled={acting} className="btn-ghost text-sm disabled:opacity-50">
            Decline
          </button>
        </div>
      )}
    </div>
  )
}
