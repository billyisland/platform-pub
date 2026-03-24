'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import type { NoteEvent } from '../../lib/ndk'
import { useWriterName } from '../../hooks/useWriterName'
import { useAuth } from '../../stores/auth'
import { isImageUrl, isEmbeddableUrl, extractUrls } from '../../lib/media'
import { ReplySection } from '../replies/ReplySection'
import { QuoteCard } from './QuoteCard'
import { VoteControls } from '../ui/VoteControls'
import { replies as repliesApi } from '../../lib/api'
import type { VoteTally, MyVoteCount } from '../../lib/api'
import type { QuoteTarget } from '../../lib/publishNote'

interface NoteCardProps {
  note: NoteEvent
  onDeleted?: (id: string) => void
  onQuote?: (target: QuoteTarget) => void
  voteTally?: VoteTally
  myVoteCounts?: MyVoteCount
}

// Ghost pill button style for dark stone background
const darkPillStyle: React.CSSProperties = {
  fontFamily: '"Source Sans 3", system-ui, sans-serif',
  fontSize: '12px',
  color: 'rgba(245, 240, 232, 0.7)',
  background: 'rgba(245, 240, 232, 0.05)',
  border: '1px solid rgba(245, 240, 232, 0.13)',
  borderRadius: '20px',
  padding: '4px 14px',
  cursor: 'pointer',
  transition: 'background 0.15s ease, color 0.15s ease',
}

function ExcerptPennant({ note }: { note: NoteEvent }) {
  const ref = useRef<HTMLDivElement>(null)
  const [articleDTag, setArticleDTag] = useState<string | null>(null)
  const [isPaywalled, setIsPaywalled] = useState(false)

  function applySwallowtail() {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    if (w === 0 || h === 0) return
    const forkDepth = 28
    const vX = ((w - forkDepth) / w) * 100
    el.style.clipPath = `polygon(0% 0%, 100% 0%, ${vX}% 50%, 100% 100%, 0% 100%)`
  }

  useEffect(() => {
    function run() { applySwallowtail() }
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.ready.then(run)
    } else {
      run()
    }
    window.addEventListener('resize', run)
    return () => window.removeEventListener('resize', run)
  }, [note.quotedExcerpt])

  useEffect(() => {
    if (!note.quotedEventId) return
    fetch(`/api/v1/content/resolve?eventId=${encodeURIComponent(note.quotedEventId)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.dTag) setArticleDTag(data.dTag)
        if (data?.isPaywalled) setIsPaywalled(true)
      })
      .catch(() => {})
  }, [note.quotedEventId])

  const inner = (
    <div
      ref={ref}
      style={{
        background: '#FAF7F2',
        borderLeft: isPaywalled ? '5px solid #9B1C20' : 'none',
        paddingTop: '10px',
        paddingBottom: '10px',
        paddingLeft: isPaywalled ? '11px' : '14px',
        paddingRight: '48px',
      }}
    >
      <p style={{ fontFamily: '"Newsreader", Georgia, serif', fontStyle: 'italic', fontSize: '14px', color: '#4A4845', lineHeight: 1.5, marginBottom: note.quotedTitle || note.quotedAuthor ? '5px' : 0 }}>
        {note.quotedExcerpt}
      </p>
      {(note.quotedTitle || note.quotedAuthor) && (
        <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7A7774' }}>
          {note.quotedTitle}{note.quotedTitle && note.quotedAuthor ? ' — ' : ''}{note.quotedAuthor}
        </p>
      )}
    </div>
  )

  if (articleDTag) {
    return (
      <Link href={`/article/${articleDTag}`} onClick={e => e.stopPropagation()} className="block mt-2.5" style={{ marginRight: '-16px' }}>
        {inner}
      </Link>
    )
  }
  return <div className="mt-2.5" style={{ marginRight: '-16px' }}>{inner}</div>
}

export function NoteCard({ note, onDeleted, onQuote, voteTally, myVoteCounts }: NoteCardProps) {
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
    <div style={{ background: '#2A2A2A', borderRadius: '14px', overflow: 'visible' }}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Avatar */}
          {writerInfo?.username ? (
            <Link href={`/${writerInfo.username}`} className="flex-shrink-0">
              {writerInfo.avatar ? (
                <img src={writerInfo.avatar} alt="" className="h-9 w-9 rounded-full object-cover" />
              ) : (
                <span
                  className="flex h-9 w-9 items-center justify-center text-xs font-medium rounded-full"
                  style={{ background: 'linear-gradient(135deg, #3A1515, #5A2020)', color: '#EAE5DC' }}
                >
                  {(writerInfo.displayName?.[0] ?? note.pubkey[0]).toUpperCase()}
                </span>
              )}
            </Link>
          ) : writerInfo?.avatar ? (
            <img src={writerInfo.avatar} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
          ) : (
            <span
              className="flex h-9 w-9 items-center justify-center text-xs font-medium flex-shrink-0 rounded-full"
              style={{ background: 'linear-gradient(135deg, #3A1515, #5A2020)', color: '#EAE5DC' }}
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
                  style={{ fontSize: '15px', fontWeight: 700, color: '#F5F0E8' }}
                  className="hover:opacity-80 transition-opacity"
                >
                  {writerInfo.displayName ?? note.pubkey.slice(0, 12) + '...'}
                </Link>
              ) : (
                <span style={{ fontSize: '15px', fontWeight: 700, color: '#F5F0E8' }}>
                  {writerInfo?.displayName ?? note.pubkey.slice(0, 12) + '...'}
                </span>
              )}
              <span style={{ fontSize: '13px', color: '#9E9B97' }}>
                {formatDate(note.publishedAt)}
              </span>
              {isAuthor && (
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="ml-auto rounded-full px-2.5 py-0.5 disabled:opacity-40 transition-colors"
                  style={confirmDelete
                    ? { fontSize: '12px', color: '#ff6b6b', background: 'rgba(255,107,107,0.15)', fontWeight: 500 }
                    : { fontSize: '12px', color: 'rgba(245,240,232,0.35)' }
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
                style={{ fontSize: '16px', color: '#EAE5DC', lineHeight: '1.55' }}
              >
                {displayContent}
              </p>
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
            {note.quotedExcerpt ? (
              <ExcerptPennant note={note} />
            ) : note.quotedEventId ? (
              <QuoteCard eventId={note.quotedEventId} />
            ) : null}

            {/* Action pills */}
            <div className="mt-3 flex items-center gap-1.5">
              <button
                onClick={() => setShowReplies(!showReplies)}
                style={darkPillStyle}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(245,240,232,0.12)'
                  ;(e.currentTarget as HTMLButtonElement).style.color = '#F5F0E8'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(245,240,232,0.05)'
                  ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(245,240,232,0.7)'
                }}
              >
                {showReplies
                  ? 'Hide replies'
                  : replyCount !== null && replyCount > 0
                    ? <><span style={{ fontWeight: 500, color: '#EAE5DC' }}>{replyCount}</span>{' '}{replyCount !== 1 ? 'replies' : 'reply'}</>
                    : 'Reply'}
              </button>
              {user && onQuote && (
                <button
                  onClick={handleQuote}
                  style={darkPillStyle}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.background = 'rgba(245,240,232,0.12)'
                    ;(e.currentTarget as HTMLButtonElement).style.color = '#F5F0E8'
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.background = 'rgba(245,240,232,0.05)'
                    ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(245,240,232,0.7)'
                  }}
                >
                  Quote
                </button>
              )}
              <VoteControls
                targetEventId={note.id}
                targetKind={1}
                isOwnContent={isAuthor}
                dark={true}
                initialTally={voteTally}
                initialMyVotes={myVoteCounts}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Replies */}
      {showReplies && (
        <div style={{ borderTop: '1px solid rgba(245,240,232,0.08)' }} className="px-4 pb-3">
          <ReplySection targetEventId={note.id} targetKind={1} targetAuthorPubkey={note.pubkey} compact dark />
        </div>
      )}
    </div>
  )
}

function EmbedPreview({ url }: { url: string }) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  if (yt) return <div className="relative overflow-hidden rounded-lg" style={{ paddingBottom: '56.25%' }}><iframe src={`https://www.youtube.com/embed/${yt[1]}`} className="absolute inset-0 w-full h-full" frameBorder="0" allowFullScreen loading="lazy" /></div>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block p-3 rounded-lg hover:opacity-80 transition-opacity" style={{ background: 'rgba(255,255,255,0.06)' }}>
      <p className="text-ui-xs truncate" style={{ color: '#9E9B97' }}>{url}</p>
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
