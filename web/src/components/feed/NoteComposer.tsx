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
    <div className="bg-surface-raised p-4 mb-4">
      <div className="flex gap-3">
        {user.avatar
          ? <img src={user.avatar} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
          : <span className="flex h-9 w-9 items-center justify-center bg-surface-sunken text-xs font-medium text-content-muted flex-shrink-0">{initial}</span>
        }
        <div className="flex-1 min-w-0">
          <textarea
            ref={ref}
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePost() } }}
            placeholder={activeQuote ? 'Add your thoughts...' : "What's on your mind?"}
            rows={2}
            className="w-full resize-none bg-surface-raised text-ui-sm text-content-primary placeholder:text-content-faint focus:bg-white focus:outline-none leading-relaxed transition-colors px-3 py-2"
          />

          {/* Quote preview — inline, no API call needed */}
          {activeQuote && (
            <div className="mt-2 border border-surface-strong bg-surface-sunken p-3 flex gap-2">
              <div className="w-[3px] bg-accent flex-shrink-0 self-stretch" />
              <div className="flex-1 min-w-0">
                <p className="text-ui-xs font-medium text-content-muted mb-0.5">
                  {activeQuote.previewAuthorName ?? activeQuote.authorPubkey.slice(0, 10) + '…'}
                </p>
                {activeQuote.previewTitle && (
                  <p className="text-ui-sm font-medium text-content-primary leading-snug mb-0.5 line-clamp-1">
                    {activeQuote.previewTitle}
                  </p>
                )}
                {activeQuote.previewContent ? (
                  <p className="text-ui-xs text-content-secondary leading-relaxed line-clamp-2">
                    {activeQuote.previewContent}
                  </p>
                ) : (
                  <p className="text-ui-xs text-content-faint italic">Note</p>
                )}
              </div>
              <button
                onClick={handleClearQuote}
                className="w-5 h-5 flex items-center justify-center bg-surface-strong hover:bg-surface-strong/80 text-content-muted text-xs rounded-full transition-colors flex-shrink-0 self-start"
                title="Remove quote"
              >
                ×
              </button>
            </div>
          )}

          {error && (
            <div className="mt-2 bg-surface-sunken px-3 py-2 text-ui-xs text-content-primary flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-2 text-content-faint hover:text-ink-900">×</button>
            </div>
          )}

          <div className="mt-2 flex items-center justify-between">
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
                className="btn-soft disabled:opacity-40 py-1.5 px-3 text-ui-xs"
              >
                {uploading ? 'Uploading...' : 'Image'}
              </button>
              <button onClick={handlePost} disabled={!canPost} className="btn disabled:opacity-40 py-1.5 px-4 text-ui-xs">
                {publishing ? 'Posting...' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
