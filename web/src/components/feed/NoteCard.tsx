'use client'

import { useState, useEffect } from 'react'
import type { NoteEvent } from '../../lib/ndk'
import { useWriterName } from '../../hooks/useWriterName'
import { useAuth } from '../../stores/auth'
import { isImageUrl, isEmbeddableUrl, extractUrls } from '../../lib/media'
import { ReplySection } from '../replies/ReplySection'
import { QuoteCard } from './QuoteCard'
import { replies as repliesApi } from '../../lib/api'
import type { QuoteTarget } from '../../lib/publishNote'

interface NoteCardProps {
  note: NoteEvent
  onDeleted?: (id: string) => void
  onQuote?: (target: QuoteTarget) => void
}

export function NoteCard({ note, onDeleted, onQuote }: NoteCardProps) {
  const { user } = useAuth()
  const writerInfo = useWriterName(note.pubkey)
  const [showReplies, setShowReplies] = useState(false)
  const [replyCount, setReplyCount] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isAuthor = user?.pubkey === note.pubkey

  useEffect(() => {
    repliesApi.getForTarget(note.id).then(d => setReplyCount(d.totalCount)).catch(() => {})
  }, [note.id])

  const urls = extractUrls(note.content)
  const imageUrls = urls.filter(isImageUrl)
  const embedUrls = urls.filter(isEmbeddableUrl)
  let displayContent = note.content
  displayContent = displayContent.replace(/nostr:nevent1[a-z0-9]+/gi, '').trim()
  for (const url of [...imageUrls, ...embedUrls]) displayContent = displayContent.replace(url, '').trim()

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    setDeleting(true)
    try {
      const res = await fetch(`/api/v1/notes/${note.id}`, { method: 'DELETE', credentials: 'include' })
      if (res.ok) {
        onDeleted?.(note.id)
      } else {
        setConfirmDelete(false)
      }
    } catch {
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  function handleQuote() {
    onQuote?.({
      eventId: note.id,
      eventKind: 1,
      authorPubkey: note.pubkey,
      previewContent: displayContent.slice(0, 200),
      previewAuthorName: writerInfo?.displayName ?? note.pubkey.slice(0, 8) + '…',
    })
  }

  return (
    <div className="bg-surface-raised rounded-xl border border-surface-strong/50 hover:border-surface-strong transition-colors">
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Avatar — warm gradient for fallback */}
          {writerInfo?.avatar ? (
            <img src={writerInfo.avatar} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
          ) : (
            <span
              className="flex h-9 w-9 items-center justify-center text-xs font-medium text-accent-700 flex-shrink-0 rounded-full"
              style={{ background: 'linear-gradient(135deg, #F5D5D6, #E8A5A7)' }}
            >
              {(writerInfo?.displayName?.[0] ?? note.pubkey[0]).toUpperCase()}
            </span>
          )}

          <div className="flex-1 min-w-0">
            {/* Name + time */}
            <div className="flex items-center gap-2">
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
                  className={`ml-auto text-ui-xs rounded-full px-2.5 py-0.5 transition-colors disabled:opacity-40 ${
                    confirmDelete
                      ? 'text-red-500 bg-red-50 font-medium'
                      : 'text-content-faint hover:text-content-muted hover:bg-surface-sunken'
                  }`}
                >
                  {deleting ? '...' : confirmDelete ? 'Confirm?' : 'Delete'}
                </button>
              )}
            </div>

            {/* Content — full size, primary colour for immediacy */}
            {displayContent && (
              <p className="text-[0.9375rem] text-content-primary leading-relaxed whitespace-pre-wrap mt-1">{displayContent}</p>
            )}

            {/* Images */}
            {imageUrls.length > 0 && (
              <div className="mt-2.5 space-y-2">
                {imageUrls.map((url, i) => (
                  <img key={i} src={url} alt="" className="max-w-full max-h-80 object-cover rounded-lg" loading="lazy" />
                ))}
              </div>
            )}

            {/* Embeds */}
            {embedUrls.length > 0 && (
              <div className="mt-2.5 space-y-2">
                {embedUrls.map((url, i) => <EmbedPreview key={i} url={url} />)}
              </div>
            )}

            {/* Quoted content */}
            {note.quotedEventId && <QuoteCard eventId={note.quotedEventId} />}

            {/* Action pills — invisible at rest, fill on hover */}
            <div className="mt-2.5 flex items-center gap-1">
              <button
                onClick={() => setShowReplies(!showReplies)}
                className="text-ui-xs text-content-faint hover:text-content-primary hover:bg-surface-sunken rounded-full px-2.5 py-1 transition-colors"
              >
                {showReplies
                  ? 'Hide replies'
                  : replyCount !== null && replyCount > 0
                    ? <><span className="font-medium text-content-muted">{replyCount}</span>{' '}{replyCount !== 1 ? 'replies' : 'reply'}</>
                    : 'Reply'}
              </button>
              {user && onQuote && (
                <button
                  onClick={handleQuote}
                  className="text-ui-xs text-content-faint hover:text-content-primary hover:bg-surface-sunken rounded-full px-2.5 py-1 transition-colors"
                >
                  Quote
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Replies — inside the card, just a thin rule separating them */}
      {showReplies && (
        <div className="border-t border-surface-strong/50 px-4 pb-3">
          <ReplySection targetEventId={note.id} targetKind={1} targetAuthorPubkey={note.pubkey} compact />
        </div>
      )}
    </div>
  )
}

function EmbedPreview({ url }: { url: string }) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  if (yt) return <div className="relative overflow-hidden rounded-lg" style={{ paddingBottom: '56.25%' }}><iframe src={`https://www.youtube.com/embed/${yt[1]}`} className="absolute inset-0 w-full h-full" frameBorder="0" allowFullScreen loading="lazy" /></div>
  return <a href={url} target="_blank" rel="noopener noreferrer" className="block bg-surface-sunken/60 p-3 rounded-lg hover:bg-surface-sunken transition-colors"><p className="text-ui-xs text-content-muted truncate">{url}</p></a>
}

function formatDate(ts: number) {
  const d = new Date(ts*1000), now = new Date(), ms = now.getTime()-d.getTime()
  const mins = Math.floor(ms/60000), hrs = Math.floor(ms/3600000), days = Math.floor(ms/86400000)
  if (mins<1) return 'just now'; if (mins<60) return `${mins}m`; if (hrs<24) return `${hrs}h`
  if (days===1) return '1d'; if (days<7) return `${days}d`
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})
}
