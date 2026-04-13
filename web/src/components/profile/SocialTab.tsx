'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { NoteCard } from '../feed/NoteCard'
import { VoteControls } from '../ui/VoteControls'
import type { WriterProfile, VoteTally, MyVoteCount } from '../../lib/api'
import type { NoteEvent } from '../../lib/ndk'
import type { QuoteTarget } from '../../lib/publishNote'
import { formatDateFromISO } from '../../lib/format'

interface DbNote {
  id: string
  nostrEventId: string
  content: string
  publishedAt: string
  quotedEventId?: string
  quotedEventKind?: number
  quotedExcerpt?: string
  quotedTitle?: string
  quotedAuthor?: string
}

interface DbReply {
  id: string
  nostrEventId: string
  content: string
  publishedAt: string
  isDeleted: boolean
  targetKind: number
  targetEventId: string | null
  articleSlug: string | null
  articleTitle: string | null
  articleAuthorUsername: string | null
  articleAuthorDisplayName: string | null
  parentEventId: string | null
  parentAuthorUsername: string | null
  parentAuthorDisplayName: string | null
}

interface SocialTabProps {
  username: string
  writer: WriterProfile
  isOwnProfile: boolean
  onQuote?: (target: QuoteTarget) => void
}

export function SocialTab({ username, writer, isOwnProfile, onQuote }: SocialTabProps) {
  const [notes, setNotes] = useState<DbNote[]>([])
  const [replies, setReplies] = useState<DbReply[]>([])
  const [loading, setLoading] = useState(true)
  const [voteTallies, setVoteTallies] = useState<Record<string, VoteTally>>({})
  const [myVoteCounts, setMyVoteCounts] = useState<Record<string, MyVoteCount>>({})

  const writerName = writer.displayName ?? username

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [notesRes, repliesRes] = await Promise.all([
          fetch(`/api/v1/writers/${username}/notes?limit=50`, { credentials: 'include' }),
          fetch(`/api/v1/writers/${username}/replies?limit=50`, { credentials: 'include' }),
        ])

        const loadedNotes: DbNote[] = []
        const loadedReplies: DbReply[] = []

        if (notesRes.ok) {
          const data = await notesRes.json()
          loadedNotes.push(...(data.notes ?? []))
        }
        if (repliesRes.ok) {
          const data = await repliesRes.json()
          loadedReplies.push(...(data.replies ?? []))
        }

        setNotes(loadedNotes)
        setReplies(loadedReplies)

        // Fetch vote tallies
        const eventIds = [
          ...loadedNotes.map(n => n.nostrEventId),
          ...loadedReplies.map(r => r.nostrEventId),
        ]
        if (eventIds.length > 0) {
          const idsParam = eventIds.join(',')
          const [talliesRes, myVotesRes] = await Promise.all([
            fetch(`/api/v1/votes/tally?eventIds=${idsParam}`)
              .then(r => r.ok ? r.json() : { tallies: {} })
              .catch(() => ({ tallies: {} })),
            fetch(`/api/v1/votes/mine?eventIds=${idsParam}`, { credentials: 'include' })
              .then(r => r.ok ? r.json() : { voteCounts: {} })
              .catch(() => ({ voteCounts: {} })),
          ])
          setVoteTallies(talliesRes.tallies ?? {})
          setMyVoteCounts(myVotesRes.voteCounts ?? {})
        }
      } catch { /* silently fail */ }
      finally { setLoading(false) }
    }
    load()
  }, [username])

  const handleNoteDeleted = useCallback((id: string) => {
    setNotes(prev => prev.filter(n => n.nostrEventId !== id))
  }, [])

  if (loading) {
    return <div className="py-10 text-center text-ui-sm text-grey-300">Loading...</div>
  }

  const hasNotes = notes.length > 0
  const hasReplies = replies.length > 0

  if (!hasNotes && !hasReplies) {
    return <p className="text-ui-sm text-grey-400 py-10">No notes or replies yet.</p>
  }

  return (
    <div>
      {/* Notes section */}
      {hasNotes && (
        <>
          <h3 className="label-ui text-grey-300 mb-4">
            Notes
          </h3>
          <div className="space-y-3">
            {notes.map(n => {
              const noteEvent: NoteEvent = {
                type: 'note',
                id: n.nostrEventId,
                pubkey: writer.pubkey,
                content: n.content,
                publishedAt: Math.floor(new Date(n.publishedAt).getTime() / 1000),
                quotedEventId: n.quotedEventId,
                quotedEventKind: n.quotedEventKind,
                quotedExcerpt: n.quotedExcerpt,
                quotedTitle: n.quotedTitle,
                quotedAuthor: n.quotedAuthor,
              }
              return (
                <NoteCard
                  key={n.id}
                  note={noteEvent}
                  onDeleted={handleNoteDeleted}
                  onQuote={onQuote}
                  voteTally={voteTallies[n.nostrEventId]}
                  myVoteCounts={myVoteCounts[n.nostrEventId]}
                />
              )
            })}
          </div>
        </>
      )}

      {/* Replies section */}
      {hasReplies && (
        <>
          {hasNotes && <div className="rule-inset my-8" />}
          <h3 className="label-ui text-grey-300 mb-4">
            Replies
          </h3>
          <div className="space-y-3">
            {replies.map(r => (
              <ReplyCard
                key={r.id}
                reply={r}
                writerName={writerName}
                writerUsername={username}
                isOwnProfile={isOwnProfile}
                onQuote={onQuote}
                voteTally={voteTallies[r.nostrEventId]}
                myVoteCounts={myVoteCounts[r.nostrEventId]}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// =============================================================================
// Reply Card — enhanced context headers
// =============================================================================

function ReplyCard({
  reply,
  writerName,
  writerUsername,
  isOwnProfile,
  onQuote,
  voteTally,
  myVoteCounts,
}: {
  reply: DbReply
  writerName: string
  writerUsername: string
  isOwnProfile: boolean
  onQuote?: (target: QuoteTarget) => void
  voteTally?: VoteTally
  myVoteCounts?: MyVoteCount
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isDeleted, setIsDeleted] = useState(reply.isDeleted)
  const [content, setContent] = useState(reply.content)

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    try {
      const res = await fetch(`/api/v1/replies/${reply.id}`, { method: 'DELETE', credentials: 'include' })
      if (res.ok) {
        setIsDeleted(true)
        setContent('[deleted]')
      }
    } catch { /* ignore */ }
    setConfirmDelete(false)
  }

  if (isDeleted) {
    return (
      <div className="bg-white p-5 border-l-[3px] border-grey-200">
        <p className="label-ui text-grey-400 mb-2">{writerName} · Reply</p>
        <p className="text-ui-xs text-grey-300 italic">[Deleted]</p>
      </div>
    )
  }

  // Build the contextual subhead
  const parentName = reply.parentAuthorDisplayName ?? reply.parentAuthorUsername
  const articleHref = reply.articleSlug ? `/article/${reply.articleSlug}` : null
  const articleAuthorName = reply.articleAuthorDisplayName ?? reply.articleAuthorUsername

  return (
    <div className="bg-white p-5 border-l-[3px] border-grey-200">
      {/* Contextual header */}
      <div className="flex items-center gap-2 mb-1">
        <time className="text-ui-xs text-grey-300" dateTime={reply.publishedAt}>
          {formatDateFromISO(reply.publishedAt)}
        </time>
        {isOwnProfile && (
          <button
            onClick={handleDelete}
            className={`ml-auto text-ui-xs transition-colors ${confirmDelete ? 'text-red-500 font-medium' : 'text-grey-300 hover:text-red-500'}`}
          >
            {confirmDelete ? 'Confirm?' : 'Delete'}
          </button>
        )}
      </div>

      {/* "[User] replied to [Parent Author]" */}
      <p className="text-ui-xs text-grey-400 mb-2">
        <span className="text-grey-600">{writerName}</span>
        {' replied to '}
        {reply.parentAuthorUsername ? (
          <Link
            href={`/${reply.parentAuthorUsername}`}
            className="text-grey-600 hover:text-black transition-colors underline underline-offset-2"
          >
            {parentName}
          </Link>
        ) : (
          <span className="text-grey-600">a conversation</span>
        )}
        {/* "on [Article Title] by [Article Author]" */}
        {reply.articleSlug && reply.articleTitle && (
          <>
            {' on '}
            <Link
              href={articleHref!}
              className="text-grey-600 hover:text-black transition-colors underline underline-offset-2"
            >
              {reply.articleTitle}
            </Link>
            {articleAuthorName && (
              <>
                {' by '}
                <Link
                  href={`/${reply.articleAuthorUsername}`}
                  className="text-grey-600 hover:text-black transition-colors underline underline-offset-2"
                >
                  {articleAuthorName}
                </Link>
              </>
            )}
          </>
        )}
      </p>

      {/* Reply content */}
      {articleHref ? (
        <Link href={`${articleHref}#reply-${reply.id}`} className="block hover:opacity-80 transition-opacity">
          <p className="font-serif text-sm text-black leading-relaxed" style={{ lineHeight: '1.7' }}>{content}</p>
        </Link>
      ) : (
        <p className="font-serif text-sm text-black leading-relaxed" style={{ lineHeight: '1.7' }}>{content}</p>
      )}

      {/* Footer: vote controls + quote */}
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <div className="ml-auto flex items-center gap-2">
          {onQuote && (
            <button
              onClick={() => onQuote({ eventId: reply.nostrEventId, eventKind: 1111, authorPubkey: '', previewContent: content.slice(0, 200), previewAuthorName: writerName })}
              className="text-ui-xs text-grey-300 hover:text-black transition-colors"
            >
              Quote
            </button>
          )}
          <VoteControls targetEventId={reply.nostrEventId} targetKind={1111} isOwnContent={isOwnProfile} initialTally={voteTally} initialMyVotes={myVoteCounts} />
        </div>
      </div>
    </div>
  )
}
