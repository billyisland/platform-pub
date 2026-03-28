'use client'

import { useEffect, useRef, useState } from 'react'

interface ShareButtonProps {
  url: string
  title: string
  dark?: boolean  // kept for API compat
}

export function ShareButton({ url, title }: ShareButtonProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()

    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title, url })
      } catch {
        // User cancelled
      }
      return
    }

    setOpen((v) => !v)
  }

  async function copyLink(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
    setOpen(false)
  }

  function openX(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    window.open(
      `https://x.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`,
      '_blank',
      'noopener,noreferrer'
    )
    setOpen(false)
  }

  function openEmail(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    window.location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={handleClick}
        className="text-ui-xs transition-colors text-content-faint hover:text-content-primary"
        aria-label="Share"
      >
        {copied ? 'Copied!' : 'Share'}
      </button>

      {open && (
        <div className="absolute right-0 top-6 z-20 w-44 border-2 border-ink bg-card shadow-lg py-1">
          <button
            onClick={copyLink}
            className="w-full text-left px-3 py-2 text-xs text-content-primary hover:bg-surface-deep transition-colors"
          >
            Copy link
          </button>
          <button
            onClick={openX}
            className="w-full text-left px-3 py-2 text-xs text-content-primary hover:bg-surface-deep transition-colors"
          >
            Share on X
          </button>
          <button
            onClick={openEmail}
            className="w-full text-left px-3 py-2 text-xs text-content-primary hover:bg-surface-deep transition-colors"
          >
            Share via email
          </button>
        </div>
      )}
    </div>
  )
}
