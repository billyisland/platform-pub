'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ReportButton } from '../ui/ReportButton'

export interface CommentData {
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
  replies: CommentData[]
}

interface CommentItemProps {
  comment: CommentData
  currentUserId?: string
  contentAuthorId?: string
  depth?: number
  onReply?: (commentId: string, commentEventId: string, authorName: string) => void
  onDelete?: (commentId: string) => void
}

export function CommentItem({
  comment,
  currentUserId,
  contentAuthorId,
  depth = 0,
  onReply,
  onDelete,
}: CommentItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (comment.isMuted && !comment.isDeleted) {
    return null
  }

  const canDelete =
    currentUserId &&
    (comment.author.id === currentUserId || contentAuthorId === currentUserId)

  const authorName = comment.author.displayName ?? comment.author.username ?? 'Anonymous'
  const initial = authorName[0]?.toUpperCase() ?? '?'

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    onDelete?.(comment.id)
    setConfirmDelete(false)
  }

  return (
    <div className={`${depth > 0 ? 'ml-8 border-l-2 border-rule/40 pl-4' : ''}`}>
      <div className="py-3">
        <div className="flex items-center gap-2 mb-1.5">
          {comment.author.avatar ? (
            <img
              src={comment.author.avatar}
              alt=""
              className="h-6 w-6 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-avatar-bg text-[10px] font-medium text-content-muted">
              {initial}
            </div>
          )}
          {comment.author.username ? (
            <Link href={`/${comment.author.username}`} className="text-xs font-medium text-content-secondary hover:text-content-primary transition-colors">
              {authorName}
            </Link>
          ) : (
            <span className="text-xs font-medium text-content-secondary">
              {authorName}
            </span>
          )}
          <span className="text-xs text-content-faint">&middot;</span>
          <time
            dateTime={comment.publishedAt}
            className="text-xs text-content-faint"
          >
            {formatRelativeTime(comment.publishedAt)}
          </time>
        </div>

        <p className={`text-sm leading-relaxed whitespace-pre-wrap ${
          comment.isDeleted ? 'text-content-faint italic' : 'text-content-secondary'
        }`}>
          {comment.content}
        </p>

        {!comment.isDeleted && (
          <div className="mt-1.5 flex items-center gap-3">
            {currentUserId && onReply && depth < 2 && (
              <button
                onClick={() => onReply(comment.id, comment.nostrEventId, authorName)}
                className="text-xs text-content-faint hover:text-content-muted transition-colors"
              >
                Reply
              </button>
            )}
            {canDelete && (
              <button
                onClick={handleDelete}
                className={`text-xs transition-colors ${
                  confirmDelete
                    ? 'text-accent font-medium'
                    : 'text-content-faint hover:text-accent'
                }`}
              >
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </button>
            )}
            <ReportButton targetNostrEventId={comment.nostrEventId} />
          </div>
        )}
      </div>

      {comment.replies.length > 0 && (
        <div>
          {comment.replies.map((reply) => (
            <CommentItem
              key={reply.id}
              comment={reply}
              currentUserId={currentUserId}
              contentAuthorId={contentAuthorId}
              depth={depth + 1}
              onReply={onReply}
              onDelete={onDelete}
            />
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

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}
