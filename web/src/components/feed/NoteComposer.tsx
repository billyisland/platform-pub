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
  const [content, setContent] = useState(quoteTarget?.highlightedText ? `"${quoteTarget.highlightedText}"\n\n` : '')
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

  // Sync when parent sets a new quote target
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
    <div className="bg-surface-raised rounded-xl border border-surface-strong/50 p-4 mb-4">
      <div className="flex gap-3">
        {user.avatar
          ? <img src={user.avatar} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
          : <span
              className="flex h-9 w-9 items-center justify-center text-xs font-medium text-accent-700 flex-shrink-0 rounded-full"
              style={{ background: 'linear-gradient(135deg, #F5D5D6, #E8A5A7)' }}
            >
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
            className="w-full resize-none bg-transparent text-[0.9375rem] text-content-primary placeholder:text-content-faint focus:outline-none leading-relaxed"
          />

          {/* Quote preview — accent stripe, no outer border */}
          {activeQuote && (
            <div className="mt-2 bg-surface-sunken/60 rounded-lg border-l-[2.5px] border-accent p-3 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-ui-xs font-medium text-content-muted">
                  {activeQuote.previewAuthorName ?? activeQuote.authorPubkey.slice(0, 10) + '…'}
                </p>
                {activeQuote.previewTitle && (
                  <p className="text-ui-sm font-medium text-content-primary leading-snug mt-0.5 line-clamp-1">
                    {activeQuote.previewTitle}
                  </p>
                )}
                {activeQuote.previewContent ? (
                  <p className="text-ui-xs text-content-secondary leading-relaxed line-clamp-2 mt-0.5">
                    {activeQuote.previewContent}
                  </p>
                ) : (
                  <p className="text-ui-xs text-content-faint italic mt-0.5">Note</p>
                )}
              </div>
              <button
                onClick={handleClearQuote}
                className="text-content-faint hover:text-content-muted text-sm transition-colors flex-shrink-0 leading-none mt-0.5"
                title="Remove quote"
              >
                ×
              </button>
            </div>
          )}

          {error && (
            <div className="mt-2 bg-accent-50 text-accent-700 px-3 py-2 text-ui-xs rounded-lg flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-2 text-accent-400 hover:text-accent-700">×</button>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            <span className={`text-ui-xs transition-colors ${isOver ? 'text-red-600 font-medium' : charCount > NOTE_CHAR_LIMIT - 50 ? 'text-red-500' : 'text-content-faint'}`}>
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
                className="text-content-faint hover:text-content-muted disabled:opacity-40 transition-colors p-1.5 rounded-full hover:bg-surface-sunken"
                title="Add image"
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                  <circle cx="5.5" cy="5.5" r="1" />
                  <path d="M14.5 10.5L11 7L3.5 14.5" />
                </svg>
              </button>
              <button onClick={handlePost} disabled={!canPost} className="bg-ink text-white disabled:opacity-30 rounded-full py-1.5 px-5 text-ui-xs font-medium transition-opacity">
                {publishing ? 'Posting...' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
