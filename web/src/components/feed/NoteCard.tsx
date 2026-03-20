'use client'

import { useState, useEffect } from 'react'
import type { NoteEvent } from '../../lib/ndk'
import { useWriterName } from '../../hooks/useWriterName'
import { useAuth } from '../../stores/auth'
import { isImageUrl, isEmbeddableUrl, extractUrls } from '../../lib/media'
import { CommentSection } from '../comments/CommentSection'
import { comments as commentsApi } from '../../lib/api'

interface NoteCardProps { note: NoteEvent; onDeleted?: (id: string) => void }

export function NoteCard({ note, onDeleted }: NoteCardProps) {
  const { user } = useAuth()
  const writerInfo = useWriterName(note.pubkey)
  const [showComments, setShowComments] = useState(false)
  const [commentCount, setCommentCount] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isAuthor = user?.pubkey === note.pubkey

  useEffect(() => {
    commentsApi.getForTarget(note.id).then(d => setCommentCount(d.totalCount)).catch(() => {})
  }, [note.id])

  const urls = extractUrls(note.content)
  const imageUrls = urls.filter(isImageUrl)
  const embedUrls = urls.filter(isEmbeddableUrl)
  let displayContent = note.content
  for (const url of [...imageUrls, ...embedUrls]) displayContent = displayContent.replace(url, '').trim()

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      // Auto-dismiss after 3 seconds
      setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    setDeleting(true)
    try {
      const res = await fetch(`/api/v1/notes/${note.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) {
        // Immediately remove from feed
        onDeleted?.(note.id)
      } else {
        console.error('Delete failed:', res.status)
        setConfirmDelete(false)
      }
    } catch (err) {
      console.error('Delete note error:', err)
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="px-5 py-4 bg-surface border-b border-surface-sunken">
      <div className="flex items-start gap-3">
        {writerInfo?.avatar ? (
          <img src={writerInfo.avatar} alt="" className="h-8 w-8 rounded-full object-cover flex-shrink-0 mt-0.5" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center bg-surface-sunken text-[10px] font-medium text-content-muted flex-shrink-0 mt-0.5 rounded-full">
            {(writerInfo?.displayName?.[0] ?? note.pubkey[0]).toUpperCase()}
          </span>
        )}

        <div className="flex-1 min-w-0">
          {/* Name + time row */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-ui-sm font-medium text-content-primary">
              {writerInfo?.displayName ?? note.pubkey.slice(0, 12) + '...'}
            </span>
            <span className="text-ui-xs text-content-faint">
              {formatDate(note.publishedAt)}
            </span>
            {isAuthor && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className={`ml-auto text-ui-xs transition-colors disabled:opacity-40 ${
                  confirmDelete
                    ? 'text-red-600 font-medium'
                    : 'text-content-faint hover:text-content-secondary'
                }`}
              >
                {deleting ? '...' : confirmDelete ? 'Confirm delete?' : 'Delete'}
              </button>
            )}
          </div>

          {/* Content */}
          {displayContent && (
            <p className="text-sm text-content-primary leading-relaxed whitespace-pre-wrap">{displayContent}</p>
          )}

          {/* Images */}
          {imageUrls.length > 0 && (
            <div className="mt-2 space-y-2">
              {imageUrls.map((url, i) => (
                <img key={i} src={url} alt="" className="max-w-full max-h-80 object-cover rounded" loading="lazy" />
              ))}
            </div>
          )}

          {/* Embeds */}
          {embedUrls.length > 0 && (
            <div className="mt-2 space-y-2">
              {embedUrls.map((url, i) => <EmbedPreview key={i} url={url} />)}
            </div>
          )}

          {/* Actions row */}
          <div className="mt-2 flex items-center gap-4">
            <button
              onClick={() => setShowComments(!showComments)}
              className="text-ui-xs text-content-faint hover:text-accent transition-colors"
            >
              {showComments ? 'Hide' : 'Comment'}{commentCount !== null && commentCount > 0 && ` (${commentCount})`}
            </button>
          </div>

          {/* Comments */}
          {showComments && (
            <div className="mt-2">
              <CommentSection targetEventId={note.id} targetKind={1} targetAuthorPubkey={note.pubkey} compact />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function EmbedPreview({ url }: { url: string }) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  if (yt) return <div className="relative overflow-hidden rounded" style={{ paddingBottom: '56.25%' }}><iframe src={`https://www.youtube.com/embed/${yt[1]}`} className="absolute inset-0 w-full h-full" frameBorder="0" allowFullScreen loading="lazy" /></div>
  return <a href={url} target="_blank" rel="noopener noreferrer" className="block bg-surface-raised p-3 rounded hover:opacity-80 transition-opacity"><p className="text-ui-xs text-content-faint truncate">{url}</p></a>
}

function formatDate(ts: number) {
  const d = new Date(ts*1000), now = new Date(), ms = now.getTime()-d.getTime()
  const mins = Math.floor(ms/60000), hrs = Math.floor(ms/3600000), days = Math.floor(ms/86400000)
  if (mins<1) return 'just now'; if (mins<60) return `${mins}m`; if (hrs<24) return `${hrs}h`
  if (days===1) return '1d'; if (days<7) return `${days}d`
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})
}
