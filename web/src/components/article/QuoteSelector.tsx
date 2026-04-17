'use client'

import { useState, useEffect, useCallback, type RefObject } from 'react'
import { useCompose } from '../../stores/compose'

interface QuoteSelectorProps {
  articleBodyRef: RefObject<HTMLDivElement | null>
  articleId: string
  articleTitle: string
  articlePubkey: string
  writerName: string
  isLoggedIn: boolean
}

export function QuoteSelector({ articleBodyRef, articleId, articleTitle, articlePubkey, writerName, isLoggedIn }: QuoteSelectorProps) {
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string } | null>(null)
  const openCompose = useCompose((s) => s.open)

  const handleMouseUp = useCallback(() => {
    if (!isLoggedIn) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { setSelectionPopup(null); return }
    const body = articleBodyRef.current
    if (!body) return
    const range = sel.getRangeAt(0)
    if (!body.contains(range.commonAncestorContainer)) { setSelectionPopup(null); return }
    const rect = range.getBoundingClientRect()
    const words = sel.toString().trim().split(/\s+/).slice(0, 80).join(' ')
    setSelectionPopup({
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
      text: words,
    })
  }, [isLoggedIn, articleBodyRef])

  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseUp])

  return (
    <>
      {selectionPopup && (
        <div
          className="fixed z-50 bg-black text-white px-3 py-1.5 text-[12px] font-sans shadow-lg"
          style={{ left: selectionPopup.x, top: selectionPopup.y, transform: 'translate(-50%, -100%)' }}
        >
          <button
            onMouseDown={e => {
              e.preventDefault()
              openCompose('reply', {
                eventId: articleId,
                eventKind: 30023,
                authorPubkey: articlePubkey,
                highlightedText: selectionPopup.text,
                previewContent: selectionPopup.text,
                previewTitle: articleTitle,
                previewAuthorName: writerName,
              })
              setSelectionPopup(null)
            }}
          >
            Quote
          </button>
        </div>
      )}
    </>
  )
}
