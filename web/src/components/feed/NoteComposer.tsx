'use client'

import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { publishNote } from '../../lib/publishNote'
import type { QuoteTarget } from '../../lib/publishNote'
import { uploadImage } from '../../lib/media'
import type { NoteEvent } from '../../lib/ndk'

const NOTE_CHAR_LIMIT = 1000

interface NoteComposerProps {
  onPublished?: (note: NoteEvent) => void
  onClearQuote?: () => void
  quoteTarget?: QuoteTarget
}

export function NoteComposer({ onPublished, onClearQuote, quoteTarget }: NoteComposerProps) {
  const { user } = useAuth()
  const [content, setContent] = useState('')
  const [activeQuote, setActiveQuote] = useState<typeof quoteTarget | null>(quoteTarget ?? null)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const prevQuoteIdRef = useRef(quoteTarget?.eventId)

  useEffect(() => {
    const el = ref.current
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
  }, [content])

  useEffect(() => {
    if (quoteTarget?.eventId && quoteTarget.eventId !== prevQuoteIdRef.current) {
      setActiveQuote(quoteTarget)
      prevQuoteIdRef.current = quoteTarget.eventId
      setTimeout(() => ref.current?.focus(), 50)
    }
  }, [quoteTarget?.eventId])

  if (!user) return null

  const charCount = content.length
  const isOver = charCount > NOTE_CHAR_LIMIT
  const isEmpty = content.trim().length === 0
  const canPost = !isEmpty && !isOver && !publishing
  const initial = user.displayName?.[0]?.toUpperCase() ?? user.username?.[0]?.toUpperCase() ?? '?'

  async function handlePost() {
    if (!canPost || !user) return
    setPublishing(true); setError(null)
    try {
      const result = await publishNote(content.trim(), user.pubkey, activeQuote ?? undefined)
      setContent('')
      setActiveQuote(null)
      prevQuoteIdRef.current = undefined
      onClearQuote?.()
      onPublished?.({
        type: 'note',
        id: result.noteEventId,
        pubkey: user.pubkey,
        content: content.trim(),
        publishedAt: Math.floor(Date.now() / 1000),
        quotedEventId: activeQuote?.eventId,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post.')
    } finally {
      setPublishing(false)
    }
  }

  function handleClearQuote() {
    setActiveQuote(null)
    prevQuoteIdRef.current = undefined
    onClearQuote?.()
  }

  return (
    <div className="border border-grey-200 p-[0.875rem_1.25rem]">
      <div className="flex gap-3">
        {user.avatar
          ? <img src={user.avatar} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
          : <span className="flex h-9 w-9 items-center justify-center text-[10px] font-mono uppercase flex-shrink-0 rounded-full bg-grey-100 text-grey-400">
              {initial}
            </span>
        }
        <div className="flex-1 min-w-0">
          <textarea
            ref={ref}
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePost() } }}
            placeholder={activeQuote ? 'Add your thoughts...' : "What's on your mind?"}
            rows={2}
            className="w-full resize-none bg-transparent text-[15px] font-sans text-black placeholder:text-grey-300 focus:outline-none leading-relaxed border-none"
          />

          {/* Quote preview */}
          {activeQuote && (
            <div className="mt-2 bg-grey-50 border-l-2 border-crimson p-3 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                {activeQuote.highlightedText ? (
                  <>
                    <p className="font-serif italic text-sm text-grey-600 leading-relaxed line-clamp-3 mt-0.5">
                      {activeQuote.highlightedText.trim().split(/\s+/).slice(0, 80).join(' ')}
                    </p>
                    <p className="font-mono text-[12px] uppercase tracking-[0.02em] text-grey-300 mt-1">
                      {activeQuote.previewTitle && <span>{activeQuote.previewTitle}</span>}
                      {activeQuote.previewTitle && activeQuote.previewAuthorName && ' — '}
                      {activeQuote.previewAuthorName}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-mono text-[12px] uppercase tracking-[0.02em] text-grey-400">
                      {activeQuote.previewAuthorName ?? activeQuote.authorPubkey.slice(0, 10) + '…'}
                    </p>
                    {activeQuote.previewTitle && (
                      <p className="text-[13px] font-sans font-medium text-black leading-snug mt-0.5 line-clamp-1">
                        {activeQuote.previewTitle}
                      </p>
                    )}
                    {activeQuote.previewContent ? (
                      <p className="text-[12px] font-sans text-grey-600 leading-relaxed line-clamp-2 mt-0.5">
                        {activeQuote.previewContent}
                      </p>
                    ) : (
                      <p className="text-[12px] font-sans text-grey-300 italic mt-0.5">Note</p>
                    )}
                  </>
                )}
              </div>
              <button
                onClick={handleClearQuote}
                className="text-grey-300 hover:text-grey-400 text-sm transition-colors flex-shrink-0 leading-none mt-0.5"
                title="Remove quote"
              >
                ×
              </button>
            </div>
          )}

          {error && (
            <div className="mt-2 bg-grey-100 text-crimson px-3 py-2 text-[12px] font-sans flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-2 text-grey-300 hover:text-crimson">×</button>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            <span className={`font-mono text-[12px] transition-colors ${isOver ? 'text-crimson font-medium' : charCount > NOTE_CHAR_LIMIT - 50 ? 'text-crimson' : 'text-grey-300'}`}>
              {charCount > 0 && `${charCount}/${NOTE_CHAR_LIMIT}`}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = 'image/jpeg,image/png,image/gif,image/webp'
                  input.onchange = async (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0]
                    if (!file) return
                    setUploading(true)
                    try {
                      const r = await uploadImage(file)
                      setContent(p => p + (p ? '\n' : '') + r.url)
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Upload failed')
                    } finally {
                      setUploading(false)
                    }
                  }
                  input.click()
                }}
                disabled={uploading}
                className="text-grey-300 hover:text-grey-400 disabled:opacity-40 transition-colors p-1.5 hover:bg-grey-100"
                title="Add image"
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                  <circle cx="5.5" cy="5.5" r="1" />
                  <path d="M14.5 10.5L11 7L3.5 14.5" />
                </svg>
              </button>
              <button onClick={handlePost} disabled={!canPost} className="btn disabled:opacity-30 py-1.5 px-5 text-[12px] font-sans font-semibold">
                {publishing ? 'Posting...' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
