'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { CommentComposer } from './CommentComposer'
import { CommentItem, type CommentData } from './CommentItem'

const API_BASE = '/api/v1'

interface CommentSectionProps {
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  contentAuthorId?: string
  compact?: boolean
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
      return prev.map(c => {
        if (c.id === replyTarget?.commentId) {
          return { ...c, replies: [...c.replies, comment] }
        }
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
      <div className="mt-8 pt-6 border-t border-rule">
        <div className="h-4 w-28 animate-pulse bg-surface-deep mb-4" />
        <div className="space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="h-16 animate-pulse bg-surface-deep" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={`${compact ? 'mt-3' : 'mt-8 pt-6 border-t border-rule'}`}>
      <h3 className={`font-medium mb-4 ${compact ? 'text-xs text-content-muted' : 'text-sm text-content-secondary'}`}>
        {totalCount > 0
          ? `${totalCount} comment${totalCount !== 1 ? 's' : ''}`
          : 'Comments'}
      </h3>

      {commentsEnabled && user ? (
        <CommentComposer
          targetEventId={targetEventId}
          targetKind={targetKind}
          targetAuthorPubkey={targetAuthorPubkey}
          onPublished={handleNewComment}
        />
      ) : !commentsEnabled ? (
        <p className="text-xs text-content-faint italic mb-4">
          The author has closed comments on this piece.
        </p>
      ) : (
        <p className="text-xs text-content-faint mb-4">
          <a href="/auth?mode=login" className="text-accent hover:text-accent-dark">
            Log in
          </a>{' '}
          to leave a comment.
        </p>
      )}

      {comments.length > 0 && (
        <div className="divide-y divide-rule/50">
          {comments.map((comment) => (
            <div key={comment.id}>
              <CommentItem
                comment={compact ? { ...comment, replies: [] } : comment}
                currentUserId={user?.id}
                contentAuthorId={contentAuthorId}
                onReply={commentsEnabled ? handleReply : undefined}
                onDelete={handleDelete}
              />
              {replyTarget?.commentId === comment.id && (
                <div className="ml-8 pl-4 border-l-2 border-rule/50">
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

function markDeleted(comments: CommentData[], id: string): CommentData[] {
  return comments.map(c => {
    if (c.id === id) {
      return { ...c, content: '[deleted]', isDeleted: true }
    }
    return { ...c, replies: markDeleted(c.replies, id) }
  })
}
