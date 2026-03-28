'use client'

import { formatPence } from '../../lib/voting'

interface VoteConfirmModalProps {
  direction: 'up' | 'down'
  sequenceNumber: number
  costPence: number
  totalSpentPence: number
  onConfirm: () => void
  onCancel: () => void
}

export function VoteConfirmModal({
  direction,
  sequenceNumber,
  costPence,
  totalSpentPence,
  onConfirm,
  onCancel,
}: VoteConfirmModalProps) {
  const ordinal = toOrdinal(sequenceNumber)
  const directionLabel = direction === 'up' ? 'upvote' : 'downvote'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="mx-4 w-full max-w-sm bg-card border border-rule shadow-xl p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-center mb-4">
          <span className="text-3xl text-content-muted">
            {direction === 'up' ? '▲' : '▼'}
          </span>
        </div>

        <p className="text-ui-sm text-content-primary text-center mb-1">
          This is your <span className="font-medium">{ordinal} {directionLabel}</span> on this content.
        </p>

        <p className="text-2xl font-medium text-ink text-center mt-4 mb-1">
          {formatPence(costPence)}
        </p>

        {totalSpentPence > 0 && (
          <p className="text-ui-xs text-content-faint text-center mb-4">
            Your total spend on this content: {formatPence(totalSpentPence + costPence)}
          </p>
        )}

        <div className="mt-6 flex gap-3">
          <button
            onClick={onCancel}
            className="btn-soft flex-1 py-2.5 text-ui-sm"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn-accent flex-1 py-2.5 text-ui-sm font-medium"
          >
            Confirm — {formatPence(costPence)}
          </button>
        </div>
      </div>
    </div>
  )
}

function toOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}
