'use client'

import { useEffect, useRef, useState } from 'react'

// NewFeedPrompt — slice 3, minimal naming dialog for ∀ → New feed.
// Source-set authoring lives in a later slice; this only captures a name and
// hands it back to the caller, which posts to /api/v1/feeds.

const TOKENS = {
  scrim: 'rgba(26, 26, 24, 0.4)',
  panelBg: '#FFFFFF',
  panelBorder: '#1A1A18',
  hintFg: '#8A8880',
  errorFg: '#B5242A',
  inputBorder: '#E6E5E0',
  primaryBg: '#1A1A18',
  primaryFg: '#F0EFEB',
  primaryDisabled: '#BBBBBB',
}

const NAME_LIMIT = 80

interface NewFeedPromptProps {
  open: boolean
  onClose: () => void
  onCreate: (name: string) => Promise<void>
}

export function NewFeedPrompt({ open, onClose, onCreate }: NewFeedPromptProps) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setSubmitting(false)
    setError(null)
    const t = setTimeout(() => inputRef.current?.focus(), 0)
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

  const trimmed = name.trim()
  const overLimit = trimmed.length > NAME_LIMIT
  const canSubmit = !!trimmed && !overLimit && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onCreate(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create feed.')
      setSubmitting(false)
    }
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
      aria-label="New feed"
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
        <label
          className="label-ui block"
          htmlFor="new-feed-name"
          style={{ color: TOKENS.hintFg, marginBottom: 6 }}
        >
          Feed name
        </label>
        <input
          id="new-feed-name"
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void handleSubmit()
            }
          }}
          placeholder="e.g. Politics, Friends, Reading list"
          className="font-sans text-[14px] w-full"
          style={{
            border: `1px solid ${TOKENS.inputBorder}`,
            padding: '10px 12px',
            outline: 'none',
            marginBottom: 12,
          }}
        />
        <div
          className="font-mono text-[11px]"
          style={{ color: TOKENS.hintFg, marginBottom: 16 }}
        >
          Sources arrive in a later slice — for now this feed shows the explore stream.
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div className="font-mono text-[11px]" style={{ color: TOKENS.hintFg }}>
            {error ? (
              <span style={{ color: TOKENS.errorFg }}>{error}</span>
            ) : overLimit ? (
              <span style={{ color: TOKENS.errorFg }}>
                Name must be {NAME_LIMIT} characters or fewer.
              </span>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
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
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="font-sans text-[13px]"
              style={{
                padding: '8px 16px',
                background: canSubmit ? TOKENS.primaryBg : TOKENS.primaryDisabled,
                color: TOKENS.primaryFg,
                border: 'none',
                cursor: canSubmit ? 'pointer' : 'default',
              }}
            >
              {submitting ? 'Creating…' : 'Create feed'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
