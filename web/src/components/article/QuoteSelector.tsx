'use client'

import { useState, useEffect, useCallback, type RefObject } from 'react'
import { NoteComposer } from '../feed/NoteComposer'

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
  const [quoteComposerText, setQuoteComposerText] = useState<string | null>(null)

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
              setQuoteComposerText(selectionPopup.text)
              setSelectionPopup(null)
            }}
          >
            Quote
          </button>
        </div>
      )}

      {quoteComposerText !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setQuoteComposerText(null)}
        >
          <div className="w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <NoteComposer
              quoteTarget={{
                eventId: articleId,
                eventKind: 30023,
                authorPubkey: articlePubkey,
                highlightedText: quoteComposerText,
                previewContent: quoteComposerText,
                previewTitle: articleTitle,
                previewAuthorName: writerName,
              }}
              onPublished={() => setQuoteComposerText(null)}
            />
          </div>
        </div>
      )}
    </>
  )
}
