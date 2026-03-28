'use client'

import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { publishReply } from '../../lib/replies'
import { uploadImage } from '../../lib/media'

const REPLY_CHAR_LIMIT = 2000

interface ReplyComposerProps {
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  parentCommentId?: string
  parentCommentEventId?: string
  replyingToName?: string
  onPublished?: (reply: any) => void
  onCancel?: () => void
}

export function ReplyComposer({
  targetEventId,
  targetKind,
  targetAuthorPubkey,
  parentCommentId,
  parentCommentEventId,
  replyingToName,
  onPublished,
  onCancel,
}: ReplyComposerProps) {
  const { user } = useAuth()
  const [content, setContent] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [content])

  useEffect(() => {
    if (parentCommentId && inputRef.current) {
      inputRef.current.focus()
    }
  }, [parentCommentId])

  if (!user) return null

  const charCount = content.length
  const isOverLimit = charCount > REPLY_CHAR_LIMIT
  const canPost = content.trim().length > 0 && !isOverLimit && !publishing

  async function handlePost() {
    if (!canPost || !user) return
    setPublishing(true)
    setError(null)
    try {
      const result = await publishReply({
        content: content.trim(),
        targetEventId,
        targetKind,
        targetAuthorPubkey,
        parentCommentId,
        parentCommentEventId,
      })
      setContent('')
      onPublished?.({
        id: result.replyId,
        nostrEventId: result.replyEventId,
        author: { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar },
        content: content.trim(),
        publishedAt: new Date().toISOString(),
        isDeleted: false,
        isMuted: false,
        replies: [],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post reply.')
    } finally {
      setPublishing(false)
    }
  }

  async function handleImageUpload() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/jpeg,image/png,image/gif,image/webp'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      setUploading(true)
      try {
        const r = await uploadImage(file)
        setContent(prev => prev + (prev ? '\n' : '') + r.url)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed')
      } finally {
        setUploading(false)
      }
    }
    input.click()
  }

  const isExpanded = focused || content.length > 0

  return (
    <div className="pt-2">
      {replyingToName && (
        <p className="text-ui-xs text-content-faint mb-1.5 flex items-center gap-1">
          Replying to <span className="font-medium text-content-muted">{replyingToName}</span>
          {onCancel && (
            <button onClick={onCancel} className="text-content-faint hover:text-content-muted ml-1">×</button>
          )}
        </p>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <textarea
            ref={inputRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePost() } }}
            placeholder="Reply..."
            rows={1}
            className={`w-full resize-none text-ui-sm text-content-primary placeholder:text-content-faint focus:outline-none leading-relaxed transition-all ${
              isExpanded
                ? 'bg-card px-3.5 py-2 border-2 border-ink/30 focus:border-ink'
                : 'bg-surface-deep/60 px-3.5 py-2'
            }`}
          />
        </div>

        <div className="flex items-center gap-1.5 pb-0.5">
          {isExpanded && (
            <button
              onClick={handleImageUpload}
              disabled={uploading}
              className="text-content-faint hover:text-content-muted disabled:opacity-40 transition-colors p-1.5"
              title="Add image"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                <circle cx="5.5" cy="5.5" r="1" />
                <path d="M14.5 10.5L11 7L3.5 14.5" />
              </svg>
            </button>
          )}
          <button
            onClick={handlePost}
            disabled={!canPost}
            className="btn disabled:opacity-30 px-3.5 py-1.5 text-ui-xs font-medium"
          >
            {publishing ? '...' : 'Post'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-1.5 bg-surface-deep text-accent px-3 py-1.5 text-ui-xs flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-content-faint hover:text-accent">×</button>
        </div>
      )}

      {isExpanded && charCount > REPLY_CHAR_LIMIT - 200 && (
        <p className={`text-ui-xs mt-1 transition-colors ${
          isOverLimit ? 'text-accent font-medium' : 'text-content-faint'
        }`}>
          {charCount}/{REPLY_CHAR_LIMIT}
        </p>
      )}
    </div>
  )
}
