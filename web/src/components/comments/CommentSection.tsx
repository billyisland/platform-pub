'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { CommentComposer } from './CommentComposer'
import { CommentItem, type CommentData } from './CommentItem'

// =============================================================================
// CommentSection
//
// Fetches and displays threaded comments for an article or note.
// Includes a top-level compose box and inline reply compose boxes.
// Handles soft-delete for comment authors and content authors.
// =============================================================================

const API_BASE = '/api/v1'

interface CommentSectionProps {
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  contentAuthorId?: string
  compact?: boolean // For notes: single-level, no threading
}

export function CommentSection({
  targetEventId,
  targetKind,
  targetAuthorPubkey,
  contentAuthorId,
  compact = false,
}: CommentSectionProps) {
  const { user } = useAuth()
  const [comments, setComments] = useState<CommentData[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [commentsEnabled, setCommentsEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [replyTarget, setReplyTarget] = useState<{
    commentId: string
    commentEventId: string
    authorName: string
  } | null>(null)

  useEffect(() => {
    async function loadComments() {
      setLoading(true)
      try {
        const res = await fetch(
          `${API_BASE}/comments/${targetEventId}`,
          { credentials: 'include' }
        )
        if (res.ok) {
          const data = await res.json()
          setComments(data.comments ?? [])
          setTotalCount(data.totalCount ?? 0)
          setCommentsEnabled(data.commentsEnabled ?? true)
        }
      } catch (err) {
        console.error('Failed to load comments:', err)
      } finally {
        setLoading(false)
      }
    }

    loadComments()
  }, [targetEventId])

  const handleNewComment = useCallback((comment: CommentData) => {
    setComments(prev => [...prev, comment])
    setTotalCount(prev => prev + 1)
  }, [])

  const handleNewReply = useCallback((comment: CommentData) => {
    setComments(prev => {
      // Find the parent and add the reply
      return prev.map(c => {
        if (c.id === replyTarget?.commentId) {
          return { ...c, replies: [...c.replies, comment] }
        }
        // Check one level deeper
        return {
          ...c,
          replies: c.replies.map(r => {
            if (r.id === replyTarget?.commentId) {
              return { ...r, replies: [...r.replies, comment] }
            }
            return r
          }),
        }
      })
    })
    setTotalCount(prev => prev + 1)
    setReplyTarget(null)
  }, [replyTarget])

  const handleDelete = useCallback(async (commentId: string) => {
    try {
      const res = await fetch(`${API_BASE}/comments/${commentId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) {
        // Mark as deleted in UI
        setComments(prev => markDeleted(prev, commentId))
        setTotalCount(prev => prev - 1)
      }
    } catch (err) {
      console.error('Failed to delete comment:', err)
    }
  }, [])

  const handleReply = useCallback((commentId: string, commentEventId: string, authorName: string) => {
    setReplyTarget({ commentId, commentEventId, authorName })
  }, [])

  if (loading) {
    return (
      <div className="mt-8 pt-6 border-t border-ink-200">
        <div className="h-4 w-28 animate-pulse rounded bg-ink-100 mb-4" />
        <div className="space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="h-16 animate-pulse rounded bg-ink-50" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={`${compact ? 'mt-3' : 'mt-8 pt-6 border-t border-ink-200'}`}>
      {/* Header */}
      <h3 className={`font-medium mb-4 ${compact ? 'text-xs text-ink-500' : 'text-sm text-ink-700'}`}>
        {totalCount > 0
          ? `${totalCount} comment${totalCount !== 1 ? 's' : ''}`
          : 'Comments'}
      </h3>

      {/* Compose box */}
      {commentsEnabled && user ? (
        <CommentComposer
          targetEventId={targetEventId}
          targetKind={targetKind}
          targetAuthorPubkey={targetAuthorPubkey}
          onPublished={handleNewComment}
        />
      ) : !commentsEnabled ? (
        <p className="text-xs text-ink-400 italic mb-4">
          The author has closed comments on this piece.
        </p>
      ) : (
        <p className="text-xs text-ink-400 mb-4">
          <a href="/auth?mode=login" className="text-brand-600 hover:text-brand-700">
            Log in
          </a>{' '}
          to leave a comment.
        </p>
      )}

      {/* Comment list */}
      {comments.length > 0 && (
        <div className="divide-y divide-ink-100">
          {comments.map((comment) => (
            <div key={comment.id}>
              <CommentItem
                comment={compact ? { ...comment, replies: [] } : comment}
                currentUserId={user?.id}
                contentAuthorId={contentAuthorId}
                onReply={commentsEnabled ? handleReply : undefined}
                onDelete={handleDelete}
              />
              {/* Inline reply composer */}
              {replyTarget?.commentId === comment.id && (
                <div className="ml-8 pl-4 border-l-2 border-ink-100">
                  <CommentComposer
                    targetEventId={targetEventId}
                    targetKind={targetKind}
                    targetAuthorPubkey={targetAuthorPubkey}
                    parentCommentId={comment.id}
                    parentCommentEventId={comment.nostrEventId}
                    replyingToName={replyTarget.authorName}
                    onPublished={handleNewReply}
                    onCancel={() => setReplyTarget(null)}
                    compact
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Recursively mark a comment as deleted
function markDeleted(comments: CommentData[], id: string): CommentData[] {
  return comments.map(c => {
    if (c.id === id) {
      return { ...c, content: '[deleted]', isDeleted: true }
    }
    return { ...c, replies: markDeleted(c.replies, id) }
  })
}
