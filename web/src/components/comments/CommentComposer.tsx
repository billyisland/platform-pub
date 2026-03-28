'use client'

import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { publishComment } from '../../lib/comments'

// =============================================================================
// CommentComposer
//
// Auto-resizing textarea with character counter and post button.
// Publishes a Nostr kind 1 comment event via the comment pipeline.
// =============================================================================

const COMMENT_CHAR_LIMIT = 2000

interface CommentComposerProps {
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  parentCommentId?: string
  parentCommentEventId?: string
  replyingToName?: string
  onPublished?: (comment: any) => void
  onCancel?: () => void
  compact?: boolean
}

export function CommentComposer({
  targetEventId,
  targetKind,
  targetAuthorPubkey,
  parentCommentId,
  parentCommentEventId,
  replyingToName,
  onPublished,
  onCancel,
  compact = false,
}: CommentComposerProps) {
  const { user } = useAuth()
  const [content, setContent] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [content])

  // Auto-focus when mounted as a reply
  useEffect(() => {
    if (parentCommentId && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [parentCommentId])

  if (!user) return null

  const charCount = content.length
  const isOverLimit = charCount > COMMENT_CHAR_LIMIT
  const isEmpty = content.trim().length === 0
  const canPost = !isEmpty && !isOverLimit && !publishing

  async function handlePost() {
    if (!canPost || !user) return

    setPublishing(true)
    setError(null)

    try {
      const result = await publishComment({
        content: content.trim(),
        targetEventId,
        targetKind,
        targetAuthorPubkey,
        parentCommentId,
        parentCommentEventId,
      })

      const commentData = {
        id: result.commentId,
        nostrEventId: result.commentEventId,
        author: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatar: user.avatar,
        },
        content: content.trim(),
        publishedAt: new Date().toISOString(),
        isDeleted: false,
        isMuted: false,
        replies: [],
      }

      setContent('')
      onPublished?.(commentData)
    } catch (err) {
      console.error('Comment publish error:', err)
      setError(err instanceof Error ? err.message : 'Failed to post comment.')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className={compact ? 'mt-2' : 'mb-6'}>
      {replyingToName && (
        <p className="text-xs text-content-faint mb-1">
          Replying to {replyingToName}
        </p>
      )}

      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePost() } }}
        placeholder={compact ? 'Write a reply...' : 'Write a comment...'}
        rows={compact ? 1 : 2}
        className="w-full resize-none border border-rule bg-card px-3 py-2 text-sm text-ink placeholder:text-content-faint focus:outline-none focus:border-accent leading-relaxed"
      />

      {error && (
        <div className="mt-1 text-xs text-red-600">{error}</div>
      )}

      <div className="mt-2 flex items-center justify-between">
        <span
          className={`text-xs transition-colors ${
            isOverLimit
              ? 'text-red-600 font-medium'
              : charCount > COMMENT_CHAR_LIMIT - 100
                ? 'text-red-500'
                : 'text-content-faint'
          }`}
        >
          {charCount > 0 && `${charCount}/${COMMENT_CHAR_LIMIT}`}
        </span>

        <div className="flex items-center gap-2">
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-xs text-content-faint hover:text-content-muted transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handlePost}
            disabled={!canPost}
            className="btn px-4 py-1.5 text-xs font-medium disabled:opacity-40"
          >
            {publishing ? 'Posting...' : 'Post'}
          </button>
        </div>
      </div>
    </div>
  )
}
