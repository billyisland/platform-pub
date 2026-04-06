'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ReportButton } from '../ui/ReportButton'
import { MediaContent } from '../ui/MediaContent'
import { VoteControls } from '../ui/VoteControls'
import type { VoteTally, MyVoteCount } from '../../lib/api'

export interface ReplyData {
  id: string
  nostrEventId: string
  author: {
    id: string
    username: string | null
    displayName: string | null
    avatar: string | null
  }
  content: string
  publishedAt: string
  isDeleted: boolean
  isMuted: boolean
  replies: ReplyData[]
}

interface ReplyItemProps {
  reply: ReplyData
  currentUserId?: string
  contentAuthorId?: string
  depth?: number
  compact?: boolean
  dark?: boolean  // kept for API compat
  onReply?: (replyId: string, replyEventId: string, authorName: string) => void
  onDelete?: (replyId: string) => void
  renderComposer?: (replyId: string) => ReactNode
  voteTally?: VoteTally
  myVoteCounts?: MyVoteCount
}

export function ReplyItem({
  reply,
  currentUserId,
  contentAuthorId,
  depth = 0,
  compact = false,
  onReply,
  onDelete,
  renderComposer,
  voteTally,
  myVoteCounts,
}: ReplyItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (reply.isMuted && !reply.isDeleted) {
    return null
  }

  const canDelete =
    currentUserId &&
    (reply.author.id === currentUserId || contentAuthorId === currentUserId)

  const authorName = reply.author.displayName ?? reply.author.username ?? 'Anonymous'
  const initial = authorName[0]?.toUpperCase() ?? '?'

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    onDelete?.(reply.id)
    setConfirmDelete(false)
  }

  return (
    <div id={`reply-${reply.id}`} className={`${depth > 0 ? 'ml-8 pl-3 border-l border-grey-200' : ''}`}>
      <div className={compact ? 'py-1.5' : 'py-2'}>
        <div className="flex items-start gap-2.5">
          {reply.author.avatar ? (
            <img
              src={reply.author.avatar}
              alt=""
              className="h-5 w-5  object-cover flex-shrink-0 mt-0.5"
            />
          ) : (
            <span
              className="flex h-5 w-5 items-center justify-center  text-[9px] font-medium flex-shrink-0 mt-0.5"
              style={{ background: '#F0F0F0', color: '#999999' }}
            >
              {initial}
            </span>
          )}
          <div className="flex-1 min-w-0">
            {reply.author.username ? (
              <Link href={`/${reply.author.username}`} className="font-medium text-grey-600 text-ui-xs hover:text-black transition-colors block mb-0.5">
                {authorName}
              </Link>
            ) : (
              <span className="font-medium text-grey-600 text-ui-xs block mb-0.5">
                {authorName}
              </span>
            )}
            {reply.isDeleted ? (
              <p className="text-sm leading-relaxed text-grey-300 italic">{reply.content}</p>
            ) : (
              <MediaContent
                content={reply.content}
                variant="reply"
                textClassName="text-sm leading-relaxed text-black"
              />
            )}

            {!reply.isDeleted && (
              <div className="mt-0.5 flex items-center gap-2 text-ui-xs text-grey-300">
                <time dateTime={reply.publishedAt}>
                  {formatRelativeTime(reply.publishedAt)}
                </time>
                {currentUserId && onReply && depth < 2 && (
                  <button
                    onClick={() => onReply(reply.id, reply.nostrEventId, authorName)}
                    className="hover:text-grey-400 transition-colors"
                  >
                    Reply
                  </button>
                )}
                {canDelete && (
                  <button
                    onClick={handleDelete}
                    className={`transition-colors ${
                      confirmDelete
                        ? 'text-crimson font-medium'
                        : 'hover:text-crimson'
                    }`}
                  >
                    {confirmDelete ? 'Confirm?' : 'Delete'}
                  </button>
                )}
                <ReportButton targetNostrEventId={reply.nostrEventId} />
                <VoteControls
                  targetEventId={reply.nostrEventId}
                  targetKind={1111}
                  isOwnContent={reply.author.id === currentUserId}
                  initialTally={voteTally}
                  initialMyVotes={myVoteCounts}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {reply.replies.length > 0 && (
        <div>
          {reply.replies.map((nested) => (
            <div key={nested.id}>
              <ReplyItem
                reply={nested}
                currentUserId={currentUserId}
                contentAuthorId={contentAuthorId}
                depth={depth + 1}
                onReply={onReply}
                onDelete={onDelete}
                renderComposer={renderComposer}
              />
              {renderComposer?.(nested.id)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMins < 1) return 'now'
  if (diffMins < 60) return `${diffMins}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays === 1) return '1d'
  if (diffDays < 7) return `${diffDays}d`

  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}
