'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { NoteEvent } from '../../lib/ndk'
import { useWriterName } from '../../hooks/useWriterName'
import { useAuth } from '../../stores/auth'
import { stripMediaUrls } from '../../lib/media'
import { MediaContent } from '../ui/MediaContent'
import { ReplySection } from '../replies/ReplySection'
import { QuoteCard } from './QuoteCard'
import { VoteControls } from '../ui/VoteControls'
import type { VoteTally, MyVoteCount } from '../../lib/api'
import type { QuoteTarget } from '../../lib/publishNote'
import { formatDateRelative } from '../../lib/format'
import { content as contentApi } from '../../lib/api'

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
  const [isPaid, setIsPaid] = useState(false)

  useEffect(() => {
    if (!note.quotedEventId) return
    contentApi.resolve(note.quotedEventId)
      .then(data => {
        if (data?.dTag) setArticleDTag(data.dTag)
        if (data?.author?.username && data.author.username.length < 40) setAuthorUsername(data.author.username)
        if (data?.isPaywalled) setIsPaid(true)
      })
      .catch(err => console.error('Failed to load quoted article metadata', err))
  }, [note.quotedEventId])

  const href = articleDTag ? `/article/${articleDTag}` : authorUsername ? `/${authorUsername}` : '#'
  const barColor = isPaid ? '#B5242A' : '#111111'

  return (
    <Link
      href={href}
      onClick={e => { e.stopPropagation(); if (href === '#') e.preventDefault() }}
      className="block mt-2.5 hover:opacity-80 transition-opacity ml-[38px]"
      style={{ borderLeft: `4px solid ${barColor}`, paddingLeft: '20px', paddingTop: '8px', paddingBottom: '8px' }}
    >
      <p className="font-serif italic text-[14px] text-grey-600 leading-[1.5]">{note.quotedExcerpt}</p>
      {(note.quotedTitle || note.quotedAuthor) && (
        <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-grey-600 mt-1">
          {note.quotedTitle ?? ''}
          {note.quotedTitle && note.quotedAuthor ? ' · ' : ''}
          {note.quotedAuthor && authorUsername ? (
            <span
              className="hover:underline underline-offset-2 cursor-pointer"
              onClick={e => { e.preventDefault(); e.stopPropagation(); window.location.href = `/${authorUsername}` }}
            >
              {note.quotedAuthor}
            </span>
          ) : note.quotedAuthor ?? ''}
        </p>
      )}
    </Link>
  )
}

export function NoteCard({ note, onDeleted, onQuote, voteTally, myVoteCounts }: NoteCardProps) {
  const { user } = useAuth()
  const writerInfo = useWriterName(note.pubkey)
  const [showComposer, setShowComposer] = useState(false)
  const [replyCount, setReplyCount] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isAuthor = user?.pubkey === note.pubkey

  const { displayText: displayContent } = stripMediaUrls(note.content)

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
    <div className="mt-5 pl-7">
      <div className="flex items-start gap-3">
        {/* Avatar — 28px square */}
        {writerInfo?.username ? (
          <Link href={`/${writerInfo.username}`} className="flex-shrink-0">
            {writerInfo.avatar ? (
              <img src={writerInfo.avatar} alt="" className="h-7 w-7 object-cover" />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center text-[10px] font-mono uppercase bg-grey-200 text-grey-400">
                {(writerInfo.displayName?.[0] ?? note.pubkey[0]).toUpperCase()}
              </span>
            )}
          </Link>
        ) : writerInfo?.avatar ? (
          <img src={writerInfo.avatar} alt="" className="h-7 w-7 object-cover flex-shrink-0" />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center text-[10px] font-mono uppercase flex-shrink-0 bg-grey-200 text-grey-400">
            {(writerInfo?.displayName?.[0] ?? note.pubkey[0]).toUpperCase()}
          </span>
        )}

        <div className="flex-1 min-w-0">
          {/* Name (Jost semibold) + time (Plex Mono) */}
          <div className="flex items-center gap-2">
            {writerInfo?.username ? (
              <Link
                href={`/${writerInfo.username}`}
                className="font-sans text-[14px] font-semibold text-black hover:opacity-80 transition-opacity"
              >
                {writerInfo.displayName ?? note.pubkey.slice(0, 12) + '...'}
              </Link>
            ) : (
              <span className="font-sans text-[14px] font-semibold text-black">
                {writerInfo?.displayName ?? note.pubkey.slice(0, 12) + '...'}
              </span>
            )}
            <span className="font-mono text-[11px] uppercase tracking-[0.02em] text-grey-600">
              {formatDateRelative(note.publishedAt)}
            </span>
            {isAuthor && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="ml-auto px-2.5 py-0.5 disabled:opacity-40 transition-colors font-mono text-[11px] uppercase"
                style={confirmDelete
                  ? { color: '#B5242A', fontWeight: 500 }
                  : { color: '#666666' }
                }
              >
                {deleting ? '...' : confirmDelete ? 'Confirm?' : 'Delete'}
              </button>
            )}
          </div>

          {/* Content + media */}
          <div className="mt-1">
            <MediaContent
              content={note.content}
              variant="note"
              textClassName="whitespace-pre-wrap font-sans text-[15px] text-black leading-[1.55]"
            />
          </div>

          {/* Quoted content */}
          {note.quotedExcerpt ? (
            <ExcerptPennant note={note} />
          ) : note.quotedEventId ? (
            <QuoteCard eventId={note.quotedEventId} />
          ) : null}

          {/* Action labels — Plex Mono caps, grey-600 */}
          <div className="mt-3 flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-600">
            <button
              onClick={() => setShowComposer(c => !c)}
              className="hover:text-black transition-colors"
            >
              {replyCount > 0 ? `Replies (${replyCount})` : 'Reply'}
            </button>
            {user && onQuote && (
              <button
                onClick={handleQuote}
                className="hover:text-black transition-colors"
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
      <div className="ml-[42px] mt-1">
        <ReplySection
          targetEventId={note.id}
          targetKind={1}
          targetAuthorPubkey={note.pubkey}
          compact
          previewLimit={3}
          composerOpen={showComposer}
          onComposerClose={() => setShowComposer(false)}
          onReplyCountLoaded={setReplyCount}
        />
      </div>
    </div>
  )
}

