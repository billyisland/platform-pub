'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { NoteEvent } from '../../lib/ndk'
import { useWriterName } from '../../hooks/useWriterName'
import { useAuth } from '../../stores/auth'
import { isImageUrl, isEmbeddableUrl, extractUrls } from '../../lib/media'
import { ReplySection } from '../replies/ReplySection'
import { QuoteCard } from './QuoteCard'
import { VoteControls } from '../ui/VoteControls'
import type { VoteTally, MyVoteCount } from '../../lib/api'
import type { QuoteTarget } from '../../lib/publishNote'

interface NoteCardProps {
  note: NoteEvent
  onDeleted?: (id: string) => void
  onQuote?: (target: QuoteTarget) => void
  voteTally?: VoteTally
  myVoteCounts?: MyVoteCount
}

function ExcerptPennant({ note }: { note: NoteEvent }) {
  const [articleDTag, setArticleDTag] = useState<string | null>(null)
  const [authorUsername, setAuthorUsername] = useState<string | null>(null)

  useEffect(() => {
    if (!note.quotedEventId) return
    fetch(`/api/v1/content/resolve?eventId=${encodeURIComponent(note.quotedEventId)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.dTag) setArticleDTag(data.dTag)
        if (data?.author?.username && data.author.username.length < 40) setAuthorUsername(data.author.username)
      })
      .catch(() => {})
  }, [note.quotedEventId])

  return (
    <div
      className="mt-2.5"
      style={{
        background: '#FFFAEF',
        borderLeft: '2.5px solid #B5242A',
        padding: '12px 16px',
      }}
    >
      {articleDTag ? (
        <Link href={`/article/${articleDTag}`} onClick={e => e.stopPropagation()} className="block hover:opacity-80 transition-opacity">
          <p style={{ fontFamily: '"Literata", Georgia, serif', fontStyle: 'italic', fontSize: '13.5px', color: '#263D32', lineHeight: 1.5 }}>{note.quotedExcerpt}</p>
        </Link>
      ) : (
        <p style={{ fontFamily: '"Literata", Georgia, serif', fontStyle: 'italic', fontSize: '13.5px', color: '#263D32', lineHeight: 1.5 }}>{note.quotedExcerpt}</p>
      )}
      {(note.quotedTitle || note.quotedAuthor) && (
        <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 400, color: '#ACA69C', marginTop: '4px' }}>
          {note.quotedTitle && articleDTag ? (
            <Link href={`/article/${articleDTag}`} onClick={e => e.stopPropagation()} className="hover:underline underline-offset-2">{note.quotedTitle}</Link>
          ) : note.quotedTitle}
          {note.quotedTitle && note.quotedAuthor ? ' · ' : ''}
          {note.quotedAuthor && authorUsername ? (
            <Link href={`/${authorUsername}`} onClick={e => e.stopPropagation()} className="hover:underline underline-offset-2">{note.quotedAuthor}</Link>
          ) : note.quotedAuthor}
        </p>
      )}
    </div>
  )
}

export function NoteCard({ note, onDeleted, onQuote, voteTally, myVoteCounts }: NoteCardProps) {
  const { user } = useAuth()
  const writerInfo = useWriterName(note.pubkey)
  const [showComposer, setShowComposer] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isAuthor = user?.pubkey === note.pubkey

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
    <div className="py-4">
      <div className="flex items-start gap-3">
        {/* Avatar */}
        {writerInfo?.username ? (
          <Link href={`/${writerInfo.username}`} className="flex-shrink-0">
            {writerInfo.avatar ? (
              <img src={writerInfo.avatar} alt="" className="h-[30px] w-[30px] rounded-full object-cover" />
            ) : (
              <span
                className="flex h-[30px] w-[30px] items-center justify-center text-xs font-medium rounded-full"
                style={{ background: '#C2DBC9', color: '#4A6B5A' }}
              >
                {(writerInfo.displayName?.[0] ?? note.pubkey[0]).toUpperCase()}
              </span>
            )}
          </Link>
        ) : writerInfo?.avatar ? (
          <img src={writerInfo.avatar} alt="" className="h-[30px] w-[30px] rounded-full object-cover flex-shrink-0" />
        ) : (
          <span
            className="flex h-[30px] w-[30px] items-center justify-center text-xs font-medium flex-shrink-0 rounded-full"
            style={{ background: '#C2DBC9', color: '#4A6B5A' }}
          >
            {(writerInfo?.displayName?.[0] ?? note.pubkey[0]).toUpperCase()}
          </span>
        )}

        <div className="flex-1 min-w-0">
          {/* Name + time */}
          <div className="flex items-center gap-2">
            {writerInfo?.username ? (
              <Link
                href={`/${writerInfo.username}`}
                style={{ fontSize: '14px', fontWeight: 600, color: '#0F1F18' }}
                className="hover:opacity-80 transition-opacity"
              >
                {writerInfo.displayName ?? note.pubkey.slice(0, 12) + '...'}
              </Link>
            ) : (
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#0F1F18' }}>
                {writerInfo?.displayName ?? note.pubkey.slice(0, 12) + '...'}
              </span>
            )}
            <span style={{ fontSize: '12px', color: '#7A9A8A' }}>
              {formatDate(note.publishedAt)}
            </span>
            {isAuthor && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="ml-auto px-2.5 py-0.5 disabled:opacity-40 transition-colors"
                style={confirmDelete
                  ? { fontSize: '12px', color: '#B5242A', fontWeight: 500 }
                  : { fontSize: '12px', color: '#7A9A8A' }
                }
              >
                {deleting ? '...' : confirmDelete ? 'Confirm?' : 'Delete'}
              </button>
            )}
          </div>

          {/* Content */}
          {displayContent && (
            <p
              className="whitespace-pre-wrap mt-1"
              style={{ fontSize: '15px', color: '#0F1F18', lineHeight: '1.55' }}
            >
              {displayContent}
            </p>
          )}

          {/* Images */}
          {imageUrls.length > 0 && (
            <div className="mt-2.5 space-y-2">
              {imageUrls.map((url, i) => (
                <img key={i} src={url} alt="" className="max-w-full max-h-80 object-cover" loading="lazy" />
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
          {note.quotedExcerpt ? (
            <ExcerptPennant note={note} />
          ) : note.quotedEventId ? (
            <QuoteCard eventId={note.quotedEventId} />
          ) : null}

          {/* Action labels — plain text */}
          <div className="mt-3 flex items-center gap-4" style={{ fontSize: '12px', color: '#7A9A8A' }}>
            <button
              onClick={() => setShowComposer(c => !c)}
              className="hover:text-ink transition-colors"
            >
              Reply
            </button>
            {user && onQuote && (
              <button
                onClick={handleQuote}
                className="hover:text-ink transition-colors"
              >
                Quote
              </button>
            )}
            <VoteControls
              targetEventId={note.id}
              targetKind={1}
              isOwnContent={isAuthor}
              initialTally={voteTally}
              initialMyVotes={myVoteCounts}
            />
          </div>
        </div>
      </div>

      {/* Replies */}
      {(showComposer || undefined) && (
        <div className="ml-[42px] mt-1">
          <ReplySection targetEventId={note.id} targetKind={1} targetAuthorPubkey={note.pubkey} compact previewLimit={3} composerOpen={showComposer} onComposerClose={() => setShowComposer(false)} />
        </div>
      )}
    </div>
  )
}

function EmbedPreview({ url }: { url: string }) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  if (yt) return <div className="relative overflow-hidden" style={{ paddingBottom: '56.25%' }}><iframe src={`https://www.youtube.com/embed/${yt[1]}`} className="absolute inset-0 w-full h-full" frameBorder="0" allowFullScreen loading="lazy" /></div>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block p-3 hover:opacity-80 transition-opacity" style={{ background: '#DDEEE4' }}>
      <p className="text-ui-xs truncate" style={{ color: '#4A6B5A' }}>{url}</p>
    </a>
  )
}

function formatDate(ts: number) {
  const d = new Date(ts*1000), now = new Date(), ms = now.getTime()-d.getTime()
  const mins = Math.floor(ms/60000), hrs = Math.floor(ms/3600000), days = Math.floor(ms/86400000)
  if (mins<1) return 'just now'; if (mins<60) return `${mins}m`; if (hrs<24) return `${hrs}h`
  if (days===1) return '1d'; if (days<7) return `${days}d`
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})
}
