'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { ReplyComposer } from './ReplyComposer'
import { ReplyItem, type ReplyData } from './ReplyItem'
import type { VoteTally, MyVoteCount } from '../../lib/api'

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
  compact?: boolean    // For notes: single-level, no threading
  dark?: boolean       // For notes: dark background context
  previewLimit?: number // Max top-level replies before "show older" truncation
  composerOpen?: boolean // When set, controls top-level composer visibility (undefined = always show)
  onComposerClose?: () => void // Called after a reply is published via the controlled composer
}

export function ReplySection({
  targetEventId,
  targetKind,
  targetAuthorPubkey,
  contentAuthorId,
  compact = false,
  dark = false,
  previewLimit,
  composerOpen,
  onComposerClose,
}: ReplySectionProps) {
  const { user } = useAuth()
  const [replies, setReplies] = useState<ReplyData[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [repliesEnabled, setRepliesEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [voteTallies, setVoteTallies] = useState<Record<string, VoteTally>>({})
  const [myVoteCounts, setMyVoteCounts] = useState<Record<string, MyVoteCount>>({})
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
          const comments: ReplyData[] = data.comments ?? []
          setReplies(comments)
          setTotalCount(data.totalCount ?? 0)
          setRepliesEnabled(data.repliesEnabled ?? data.commentsEnabled ?? true)

          // Batch fetch vote tallies for all replies (flatten tree)
          const allEventIds = flattenEventIds(comments)
          if (allEventIds.length > 0) {
            const idsParam = allEventIds.join(',')
            const [talliesRes, myVotesRes] = await Promise.all([
              fetch(`${API_BASE}/votes/tally?eventIds=${idsParam}`)
                .then(r => r.ok ? r.json() : { tallies: {} })
                .catch(() => ({ tallies: {} })),
              user
                ? fetch(`${API_BASE}/votes/mine?eventIds=${idsParam}`, { credentials: 'include' })
                    .then(r => r.ok ? r.json() : { voteCounts: {} })
                    .catch(() => ({ voteCounts: {} }))
                : Promise.resolve({ voteCounts: {} }),
            ])
            setVoteTallies(talliesRes.tallies ?? {})
            setMyVoteCounts(myVotesRes.voteCounts ?? {})
          }
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
          {/* "Show all" button when truncated */}
          {previewLimit && !showAll && replies.length > previewLimit && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full py-1.5 text-left text-ui-xs transition-colors"
              style={{ color: dark ? 'rgba(250,250,240,0.45)' : '#9E9B97' }}
            >
              Show all {replies.length} replies
            </button>
          )}
          {(showAll || !previewLimit ? replies : replies.slice(-previewLimit)).map((reply) => (
            <div key={reply.id}>
              <ReplyItem
                reply={reply}
                currentUserId={user?.id}
                contentAuthorId={contentAuthorId}
                compact={compact}
                dark={dark}
                onReply={repliesEnabled ? handleReplyTo : undefined}
                onDelete={handleDelete}
                voteTally={voteTallies[reply.nostrEventId]}
                myVoteCounts={myVoteCounts[reply.nostrEventId]}
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

      {/* Compose box — below existing replies; hidden when composerOpen is explicitly false */}
      {(composerOpen === undefined || composerOpen) && (
        repliesEnabled && user ? (
          <ReplyComposer
            targetEventId={targetEventId}
            targetKind={targetKind}
            targetAuthorPubkey={targetAuthorPubkey}
            onPublished={(reply) => { handleNewReply(reply); onComposerClose?.() }}
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
        )
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

// Collect all nostrEventIds in a reply tree for batch vote fetching
function flattenEventIds(replies: ReplyData[]): string[] {
  const ids: string[] = []
  for (const r of replies) {
    if (r.nostrEventId) ids.push(r.nostrEventId)
    if (r.replies.length > 0) ids.push(...flattenEventIds(r.replies))
  }
  return ids
}
