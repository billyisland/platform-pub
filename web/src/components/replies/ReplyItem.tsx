'use client'

import { useState, type ReactNode } from 'react'
import { ReportButton } from '../ui/ReportButton'

// =============================================================================
// ReplyItem — Conversational inline layout
//
// Name and text on the same line for short replies, wrapping naturally for
// longer ones. Compact feel like chat messages, not blog comments.
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
  renderComposer?: (replyId: string) => ReactNode
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
    <div className={`${depth > 0 ? 'ml-8 pl-3 border-l-2 border-surface-strong/40' : ''}`}>
      <div className={compact ? 'py-1.5' : 'py-2'}>
        {/* Inline layout: avatar | name text — all on one line for short replies */}
        <div className="flex items-start gap-2.5">
          {reply.author.avatar ? (
            <img
              src={reply.author.avatar}
              alt=""
              className="h-5 w-5 rounded-full object-cover flex-shrink-0 mt-0.5"
            />
          ) : (
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-medium text-accent-700 flex-shrink-0 mt-0.5"
              style={{ background: 'linear-gradient(135deg, #F5D5D6, #E8A5A7)' }}
            >
              {initial}
            </span>
          )}
          <div className="flex-1 min-w-0">
            {/* Name + content inline */}
            <p className={`text-sm leading-relaxed ${
              reply.isDeleted ? 'text-content-faint italic' : ''
            }`}>
              <span className="font-medium text-content-secondary text-ui-xs">
                {authorName}
              </span>{' '}
              <span className={reply.isDeleted ? 'text-content-faint' : 'text-content-primary'}>
                {reply.content}
              </span>
            </p>

            {/* Meta row: time + actions */}
            {!reply.isDeleted && (
              <div className="mt-0.5 flex items-center gap-2 text-ui-xs text-content-faint">
                <time dateTime={reply.publishedAt}>
                  {formatRelativeTime(reply.publishedAt)}
                </time>
                {currentUserId && onReply && depth < 2 && (
                  <button
                    onClick={() => onReply(reply.id, reply.nostrEventId, authorName)}
                    className="hover:text-content-muted transition-colors"
                  >
                    Reply
                  </button>
                )}
                {canDelete && (
                  <button
                    onClick={handleDelete}
                    className={`transition-colors ${
                      confirmDelete
                        ? 'text-red-500 font-medium'
                        : 'hover:text-red-500'
                    }`}
                  >
                    {confirmDelete ? 'Confirm?' : 'Delete'}
                  </button>
                )}
                <ReportButton targetNostrEventId={reply.nostrEventId} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Nested replies */}
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
