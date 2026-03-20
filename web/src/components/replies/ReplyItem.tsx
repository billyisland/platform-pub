'use client'

import { useState } from 'react'
import { ReportButton } from '../ui/ReportButton'

// =============================================================================
// ReplyItem
//
// Renders a single reply with author info, timestamp, reply button,
// delete button (for author or content owner), and report button.
// =============================================================================

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
  onReply?: (replyId: string, replyEventId: string, authorName: string) => void
  onDelete?: (replyId: string) => void
}

export function ReplyItem({
  reply,
  currentUserId,
  contentAuthorId,
  depth = 0,
  compact = false,
  onReply,
  onDelete,
}: ReplyItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (reply.isMuted && !reply.isDeleted) {
    return null // Hidden for muters
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
    <div className={`${depth > 0 ? 'ml-8 border-l-2 border-ink-100 pl-4' : ''}`}>
      <div className={compact ? 'py-2' : 'py-3'}>
        {/* Author line */}
        <div className="flex items-center gap-2 mb-1.5">
          {reply.author.avatar ? (
            <img
              src={reply.author.avatar}
              alt=""
              className="h-6 w-6 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-[10px] font-medium text-brand-700">
              {initial}
            </div>
          )}
          <span className="text-xs font-medium text-ink-600">
            {authorName}
          </span>
          <span className="text-xs text-ink-300">&middot;</span>
          <time
            dateTime={reply.publishedAt}
            className="text-xs text-ink-400"
          >
            {formatRelativeTime(reply.publishedAt)}
          </time>
        </div>

        {/* Content */}
        <p className={`text-sm leading-relaxed whitespace-pre-wrap ${
          reply.isDeleted ? 'text-ink-400 italic' : 'text-ink-700'
        }`}>
          {reply.content}
        </p>

        {/* Actions */}
        {!reply.isDeleted && (
          <div className="mt-1.5 flex items-center gap-3">
            {currentUserId && onReply && depth < 2 && (
              <button
                onClick={() => onReply(reply.id, reply.nostrEventId, authorName)}
                className="text-xs text-ink-400 hover:text-ink-600 transition-colors"
              >
                Reply
              </button>
            )}
            {canDelete && (
              <button
                onClick={handleDelete}
                className={`text-xs transition-colors ${
                  confirmDelete
                    ? 'text-red-600 font-medium'
                    : 'text-ink-400 hover:text-red-600'
                }`}
              >
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </button>
            )}
            <ReportButton targetNostrEventId={reply.nostrEventId} />
          </div>
        )}
      </div>

      {/* Nested replies */}
      {reply.replies.length > 0 && (
        <div>
          {reply.replies.map((nested) => (
            <ReplyItem
              key={nested.id}
              reply={nested}
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
