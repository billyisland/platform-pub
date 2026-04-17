'use client'

import { useState } from 'react'
import { trust, type VouchDimension, type VouchVisibility } from '../../lib/api'

// =============================================================================
// VouchModal — dimension selector + visibility + submit
//
// Opens when the user clicks "Vouch" on a writer profile. Checkboxes for four
// dimensions, radio for public/aggregate visibility. Aggregate selection shows
// a disclaimer before proceeding.
// =============================================================================

const DIMENSIONS: { key: VouchDimension; label: string; description: string }[] = [
  { key: 'humanity',  label: 'Humanity',  description: 'Are they a real human being?' },
  { key: 'encounter', label: 'Encounter', description: 'Have you met or meaningfully interacted?' },
  { key: 'identity',  label: 'Identity',  description: 'Is their presented identity consistent?' },
  { key: 'integrity', label: 'Integrity', description: 'Do they act honestly and in good faith?' },
]

interface VouchModalProps {
  subjectId: string
  subjectName: string
  existingVouches: Array<{ id: string; dimension: VouchDimension; value: string; visibility: string }>
  onClose: () => void
  onVouched: () => void
}

export function VouchModal({ subjectId, subjectName, existingVouches, onClose, onVouched }: VouchModalProps) {
  const existingDims = new Set(existingVouches.map(v => v.dimension))

  const [selected, setSelected] = useState<Set<VouchDimension>>(new Set())
  const [visibility, setVisibility] = useState<VouchVisibility>('public')
  const [showDisclaimer, setShowDisclaimer] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleDimension(dim: VouchDimension) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(dim)) next.delete(dim)
      else next.add(dim)
      return next
    })
  }

  async function handleSubmit() {
    if (selected.size === 0) return

    // Show disclaimer for aggregate-only
    if (visibility === 'aggregate' && !showDisclaimer) {
      setShowDisclaimer(true)
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      for (const dim of selected) {
        await trust.vouch({
          subjectId,
          dimension: dim,
          value: 'affirm',
          visibility,
        })
      }
      onVouched()
    } catch (err: any) {
      setError(err?.body?.error ?? 'Failed to submit vouch')
    } finally {
      setSubmitting(false)
    }
  }

  // Disclaimer step for aggregate-only
  if (showDisclaimer) {
    return (
      <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
        <div
          className="bg-white w-full max-w-sm p-6 space-y-4"
          onClick={e => e.stopPropagation()}
        >
          <h3 className="font-sans text-base font-medium text-black">Aggregate-only vouch</h3>
          <p className="text-ui-xs text-grey-500 leading-relaxed">
            This vouch will be added to the person's aggregate score. Other readers
            won't see that it came from you. The platform can see it. We're building
            a stronger-privacy channel — it's not yet available.
          </p>
          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={() => setShowDisclaimer(false)}
              className="btn-ghost py-1.5 px-4 text-ui-xs"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="btn py-1.5 px-4 text-ui-xs disabled:opacity-50"
            >
              {submitting ? '...' : 'Vouch anyway'}
            </button>
            <button
              onClick={() => { setVisibility('public'); setShowDisclaimer(false) }}
              className="btn-text-muted text-ui-xs"
            >
              Make public instead
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white w-full max-w-sm p-6 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-sans text-base font-medium text-black">
          Vouch for {subjectName}
        </h3>

        {/* Dimension checkboxes */}
        <div className="space-y-3">
          {DIMENSIONS.map(({ key, label, description }) => {
            const alreadyVouched = existingDims.has(key)
            return (
              <label
                key={key}
                className={`flex items-start gap-3 cursor-pointer ${alreadyVouched ? 'opacity-50' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  disabled={alreadyVouched}
                  onChange={() => toggleDimension(key)}
                  className="mt-0.5 accent-black"
                />
                <div>
                  <div className="text-ui-sm text-black font-medium">{label}</div>
                  <div className="text-[11px] font-sans text-grey-400">{description}</div>
                  {alreadyVouched && (
                    <div className="text-[11px] font-sans text-grey-300 italic">Already vouched</div>
                  )}
                </div>
              </label>
            )
          })}
        </div>

        {/* Visibility radio */}
        <div className="pt-2 space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="visibility"
              checked={visibility === 'public'}
              onChange={() => setVisibility('public')}
              className="accent-black"
            />
            <div>
              <span className="text-ui-sm text-black">Public endorsement</span>
              <span className="text-[11px] font-sans text-grey-400 ml-2">Visible on profiles</span>
            </div>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="visibility"
              checked={visibility === 'aggregate'}
              onChange={() => setVisibility('aggregate')}
              className="accent-black"
            />
            <div>
              <span className="text-ui-sm text-black">Aggregate only</span>
              <span className="text-[11px] font-sans text-grey-400 ml-2">Anonymous to other readers</span>
            </div>
          </label>
        </div>

        {error && (
          <p className="text-[11px] font-sans text-[#c41230]">{error}</p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2">
          <button onClick={onClose} className="btn-ghost py-1.5 px-4 text-ui-xs">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || selected.size === 0}
            className="btn py-1.5 px-4 text-ui-xs disabled:opacity-50"
          >
            {submitting ? '...' : `Vouch (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  )
}
