'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { ReplyComposer } from './ReplyComposer'
import { ReplyItem, type ReplyData } from './ReplyItem'

// =============================================================================
// ReplySection
//
// Fetches and displays threaded replies for an article or note.
// Includes a top-level compose box and inline nested reply compose boxes.
// Handles soft-delete for reply authors and content authors.
// =============================================================================

const API_BASE = '/api/v1'

interface ReplySectionProps {
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  contentAuthorId?: string
  compact?: boolean // For notes: single-level, no threading
}

export function ReplySection({
  targetEventId,
  targetKind,
  targetAuthorPubkey,
  contentAuthorId,
  compact = false,
}: ReplySectionProps) {
  const { user } = useAuth()
  const [replies, setReplies] = useState<ReplyData[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [repliesEnabled, setRepliesEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [replyTarget, setReplyTarget] = useState<{
    replyId: string
    replyEventId: string
    authorName: string
  } | null>(null)

  useEffect(() => {
    async function loadReplies() {
      setLoading(true)
      try {
        const res = await fetch(
          `${API_BASE}/replies/${targetEventId}`,
          { credentials: 'include' }
        )
        if (res.ok) {
          const data = await res.json()
          setReplies(data.comments ?? [])
          setTotalCount(data.totalCount ?? 0)
          setRepliesEnabled(data.repliesEnabled ?? data.commentsEnabled ?? true)
        }
      } catch (err) {
        console.error('Failed to load replies:', err)
      } finally {
        setLoading(false)
      }
    }

    loadReplies()
  }, [targetEventId])

  const handleNewReply = useCallback((reply: ReplyData) => {
    setReplies(prev => [...prev, reply])
    setTotalCount(prev => prev + 1)
  }, [])

  const handleNewNestedReply = useCallback((reply: ReplyData) => {
    setReplies(prev => {
      return prev.map(r => {
        if (r.id === replyTarget?.replyId) {
          return { ...r, replies: [...r.replies, reply] }
        }
        return {
          ...r,
          replies: r.replies.map(nested => {
            if (nested.id === replyTarget?.replyId) {
              return { ...nested, replies: [...nested.replies, reply] }
            }
            return nested
          }),
        }
      })
    })
    setTotalCount(prev => prev + 1)
    setReplyTarget(null)
  }, [replyTarget])

  const handleDelete = useCallback(async (replyId: string) => {
    try {
      const res = await fetch(`${API_BASE}/replies/${replyId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) {
        setReplies(prev => markDeleted(prev, replyId))
        setTotalCount(prev => prev - 1)
      }
    } catch (err) {
      console.error('Failed to delete reply:', err)
    }
  }, [])

  const handleReplyTo = useCallback((replyId: string, replyEventId: string, authorName: string) => {
    setReplyTarget({ replyId, replyEventId, authorName })
  }, [])

  if (loading) {
    return (
      <div className={compact ? '' : 'mt-8 pt-6 border-t border-ink-200'}>
        <div className="space-y-2 py-2">
          {[1, 2].map(i => (
            <div key={i} className="h-10 animate-pulse rounded bg-ink-100" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={compact ? '' : 'mt-8 pt-6 border-t border-ink-200'}>
      {/* Header — articles only; compact (note) mode omits it */}
      {!compact && (
        <h3 className="text-sm font-medium text-ink-700 mb-4">
          {totalCount > 0
            ? `${totalCount} ${totalCount !== 1 ? 'replies' : 'reply'}`
            : 'Replies'}
        </h3>
      )}

      {/* Reply list */}
      {replies.length > 0 && (
        <div className={`divide-y divide-ink-100 ${compact ? '' : 'mb-4'}`}>
          {replies.map((reply) => (
            <div key={reply.id}>
              <ReplyItem
                reply={reply}
                currentUserId={user?.id}
                contentAuthorId={contentAuthorId}
                compact={compact}
                onReply={repliesEnabled ? handleReplyTo : undefined}
                onDelete={handleDelete}
                renderComposer={(replyId) => replyTarget?.replyId === replyId ? (
                  <div className="ml-8 pl-4 border-l-2 border-ink-100">
                    <ReplyComposer
                      targetEventId={targetEventId}
                      targetKind={targetKind}
                      targetAuthorPubkey={targetAuthorPubkey}
                      parentCommentId={replyId}
                      parentCommentEventId={replyTarget.replyEventId}
                      replyingToName={replyTarget.authorName}
                      onPublished={handleNewNestedReply}
                      onCancel={() => setReplyTarget(null)}
                    />
                  </div>
                ) : null}
              />
              {/* Inline reply composer for top-level replies */}
              {replyTarget?.replyId === reply.id && (
                <div className="ml-8 pl-4 border-l-2 border-ink-100">
                  <ReplyComposer
                    targetEventId={targetEventId}
                    targetKind={targetKind}
                    targetAuthorPubkey={targetAuthorPubkey}
                    parentCommentId={reply.id}
                    parentCommentEventId={reply.nostrEventId}
                    replyingToName={replyTarget.authorName}
                    onPublished={handleNewNestedReply}
                    onCancel={() => setReplyTarget(null)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Compose box — below existing replies */}
      {repliesEnabled && user ? (
        <ReplyComposer
          targetEventId={targetEventId}
          targetKind={targetKind}
          targetAuthorPubkey={targetAuthorPubkey}
          onPublished={handleNewReply}
        />
      ) : !repliesEnabled ? (
        <p className="text-xs text-ink-400 italic mb-4">
          The author has closed replies on this piece.
        </p>
      ) : (
        <p className="text-xs text-ink-400 mb-4">
          <a href="/auth?mode=login" className="text-brand-600 hover:text-brand-700">
            Log in
          </a>{' '}
          to leave a reply.
        </p>
      )}
    </div>
  )
}

// Recursively mark a reply as deleted
function markDeleted(replies: ReplyData[], id: string): ReplyData[] {
  return replies.map(r => {
    if (r.id === id) {
      return { ...r, content: '[deleted]', isDeleted: true }
    }
    return { ...r, replies: markDeleted(r.replies, id) }
  })
}
