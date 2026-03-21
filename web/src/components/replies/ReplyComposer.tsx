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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [content])

  useEffect(() => {
    if (parentCommentId && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [parentCommentId])

  if (!user) return null

  const charCount = content.length
  const isOverLimit = charCount > REPLY_CHAR_LIMIT
  const canPost = content.trim().length > 0 && !isOverLimit && !publishing
  const initial = user.displayName?.[0]?.toUpperCase() ?? user.username?.[0]?.toUpperCase() ?? '?'

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

  return (
    <div className="flex gap-3 pt-2">
      {/* Avatar */}
      {user.avatar ? (
        <img src={user.avatar} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0 mt-1" />
      ) : (
        <span className="flex h-7 w-7 items-center justify-center bg-surface-sunken text-[10px] font-medium text-content-muted flex-shrink-0 mt-1 rounded-full">
          {initial}
        </span>
      )}

      <div className="flex-1 min-w-0">
        {replyingToName && (
          <p className="text-xs text-content-faint mb-1">Replying to {replyingToName}</p>
        )}

        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePost() } }}
          placeholder="Write a reply..."
          rows={1}
          className="w-full resize-none bg-surface-sunken text-ui-sm text-content-primary placeholder:text-content-faint focus:bg-white focus:outline-none leading-relaxed transition-colors px-3 py-2"
        />

        {error && (
          <div className="mt-1 bg-surface-sunken px-3 py-1.5 text-ui-xs text-content-primary flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-2 text-content-faint hover:text-ink-900">×</button>
          </div>
        )}

        <div className="mt-1.5 flex items-center justify-between">
          <span className={`text-ui-xs transition-colors ${
            isOverLimit ? 'text-red-600 font-medium'
              : charCount > REPLY_CHAR_LIMIT - 100 ? 'text-red-500'
              : 'text-content-faint'
          }`}>
            {charCount > 0 && `${charCount}/${REPLY_CHAR_LIMIT}`}
          </span>

          <div className="flex items-center gap-2">
            {onCancel && (
              <button onClick={onCancel} className="text-ui-xs text-content-faint hover:text-content-secondary transition-colors">
                Cancel
              </button>
            )}
            <button onClick={handleImageUpload} disabled={uploading} className="btn-soft disabled:opacity-40 py-1 px-2.5 text-ui-xs">
              {uploading ? '...' : 'Image'}
            </button>
            <button onClick={handlePost} disabled={!canPost} className="btn disabled:opacity-40 py-1 px-3 text-ui-xs">
              {publishing ? 'Posting...' : 'Reply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
