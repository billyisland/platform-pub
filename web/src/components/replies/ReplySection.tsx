'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { ReplyComposer } from './ReplyComposer'
import { ReplyItem, type ReplyData } from './ReplyItem'
import type { VoteTally, MyVoteCount } from '../../lib/api'

const API_BASE = '/api/v1'

interface ReplySectionProps {
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  contentAuthorId?: string
  compact?: boolean
  dark?: boolean  // kept for API compat
  previewLimit?: number
  composerOpen?: boolean
  onComposerClose?: () => void
  onReplyCountLoaded?: (count: number) => void
}

export function ReplySection({
  targetEventId,
  targetKind,
  targetAuthorPubkey,
  contentAuthorId,
  compact = false,
  previewLimit,
  composerOpen,
  onComposerClose,
  onReplyCountLoaded,
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
          const count = data.totalCount ?? 0
          setTotalCount(count)
          setRepliesEnabled(data.repliesEnabled ?? data.commentsEnabled ?? true)
          onReplyCountLoaded?.(count)

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
      <div className={compact ? '' : 'mt-8 pt-6 border-t-[3px] border-ink'}>
        <div className="space-y-2 py-2">
          {[1, 2].map(i => (
            <div key={i} className="h-10 animate-pulse bg-surface-deep" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={compact ? '' : 'mt-8 pt-6 border-t-[3px] border-ink'}>
      {!compact && (
        <h3 className="text-sm font-medium text-content-secondary mb-4">
          {totalCount > 0
            ? `${totalCount} ${totalCount !== 1 ? 'replies' : 'reply'}`
            : 'Replies'}
        </h3>
      )}

      {replies.length > 0 && (
        <div className={`space-y-1 ${compact ? '' : 'mb-4'}`}>
          {(showAll || !previewLimit ? replies : replies.slice(-previewLimit)).map((reply) => (
            <div key={reply.id}>
              <ReplyItem
                reply={reply}
                currentUserId={user?.id}
                contentAuthorId={contentAuthorId}
                compact={compact}
                onReply={repliesEnabled ? handleReplyTo : undefined}
                onDelete={handleDelete}
                voteTally={voteTallies[reply.nostrEventId]}
                myVoteCounts={myVoteCounts[reply.nostrEventId]}
                renderComposer={(replyId) => replyTarget?.replyId === replyId ? (
                  <div className="ml-8 pl-4 border-l-2 border-ink">
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
              {replyTarget?.replyId === reply.id && (
                <div className="ml-8 pl-4 border-l-2 border-ink">
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
          {previewLimit && !showAll && replies.length > previewLimit && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-2 px-3 py-1.5 text-ui-xs text-content-muted hover:text-white hover:bg-ink transition-colors border border-transparent hover:border-ink"
            >
              Read more replies
            </button>
          )}
        </div>
      )}

      {(composerOpen === undefined || composerOpen) && (
        repliesEnabled && user ? (
          <ReplyComposer
            targetEventId={targetEventId}
            targetKind={targetKind}
            targetAuthorPubkey={targetAuthorPubkey}
            onPublished={(reply) => { handleNewReply(reply); onComposerClose?.() }}
          />
        ) : !repliesEnabled ? (
          <p className="text-xs text-content-faint italic mb-4">
            The author has closed replies on this piece.
          </p>
        ) : (
          <p className="text-xs text-content-faint mb-4">
            <a href="/auth?mode=login" className="text-accent hover:text-accent-dark">
              Log in
            </a>{' '}
            to leave a reply.
          </p>
        )
      )}
    </div>
  )
}

function markDeleted(replies: ReplyData[], id: string): ReplyData[] {
  return replies.map(r => {
    if (r.id === id) {
      return { ...r, content: '[deleted]', isDeleted: true }
    }
    return { ...r, replies: markDeleted(r.replies, id) }
  })
}

function flattenEventIds(replies: ReplyData[]): string[] {
  const ids: string[] = []
  for (const r of replies) {
    if (r.nostrEventId) ids.push(r.nostrEventId)
    if (r.replies.length > 0) ids.push(...flattenEventIds(r.replies))
  }
  return ids
}
