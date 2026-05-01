'use client'

import { useEffect, useRef, useState } from 'react'

// ResetLayoutConfirm — slice 6, confirm dialog for ∀ → Reset workspace layout.
// Matches the scrim/panel grammar of NewFeedPrompt. The reset itself is a
// non-destructive layout-only operation (positions/sizes/brightness/density/
// orientation), but it's irreversible — committed positions are gone — so a
// confirm modal is right.

const TOKENS = {
  scrim: 'rgba(26, 26, 24, 0.4)',
  panelBg: '#FFFFFF',
  panelBorder: '#1A1A18',
  bodyFg: '#1A1A18',
  hintFg: '#8A8880',
  primaryBg: '#B5242A',
  primaryFg: '#F0EFEB',
  primaryDisabled: '#BBBBBB',
}

interface ResetLayoutConfirmProps {
  open: boolean
  vesselCount: number
  onClose: () => void
  onConfirm: () => void
}

export function ResetLayoutConfirm({
  open,
  vesselCount,
  onClose,
  onConfirm,
}: ResetLayoutConfirmProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setSubmitting(false)
    const t = setTimeout(() => confirmRef.current?.focus(), 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, submitting])

  if (!open) return null

  function handleConfirm() {
    if (submitting) return
    setSubmitting(true)
    onConfirm()
  }

  function onScrimClick(e: React.MouseEvent) {
    if (e.target === scrimRef.current && !submitting) onClose()
  }

  return (
    <div
      ref={scrimRef}
      onMouseDown={onScrimClick}
      role="dialog"
      aria-modal="true"
      aria-label="Reset workspace layout"
      style={{
        position: 'fixed',
        inset: 0,
        background: TOKENS.scrim,
        zIndex: 60,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 144,
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: 'calc(100vw - 48px)',
          background: TOKENS.panelBg,
          border: `1px solid ${TOKENS.panelBorder}`,
          padding: 24,
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.18)',
        }}
      >
        <div
          className="font-sans text-[15px]"
          style={{ color: TOKENS.bodyFg, marginBottom: 8, fontWeight: 500 }}
        >
          Reset workspace layout?
        </div>
        <div
          className="font-sans text-[13px]"
          style={{ color: TOKENS.hintFg, marginBottom: 20, lineHeight: 1.5 }}
        >
          {vesselCount === 0
            ? 'Clears stored positions, sizes, brightness, density, and orientation. Your feeds and their sources are untouched.'
            : `Returns ${vesselCount} ${vesselCount === 1 ? 'vessel' : 'vessels'} to the default grid and clears any size, brightness, density, or orientation changes. Your feeds and their sources are untouched.`}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="font-sans text-[13px]"
            style={{
              padding: '8px 14px',
              background: 'transparent',
              color: TOKENS.panelBorder,
              border: 'none',
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="font-sans text-[13px]"
            style={{
              padding: '8px 16px',
              background: submitting ? TOKENS.primaryDisabled : TOKENS.primaryBg,
              color: TOKENS.primaryFg,
              border: 'none',
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            Reset layout
          </button>
        </div>
      </div>
    </div>
  )
}
