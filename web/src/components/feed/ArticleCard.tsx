'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ArticleEvent } from '../../lib/ndk'
import { useWriterName } from '../../hooks/useWriterName'
import { useAuth } from '../../stores/auth'
import { replies as repliesApi } from '../../lib/api'
import { VoteControls } from '../ui/VoteControls'
import { ShareButton } from '../ui/ShareButton'
import type { VoteTally, MyVoteCount } from '../../lib/api'
import type { QuoteTarget } from '../../lib/publishNote'

interface ArticleCardProps {
  article: ArticleEvent
  onQuote?: (target: QuoteTarget) => void
  voteTally?: VoteTally
  myVoteCounts?: MyVoteCount
}

export function ArticleCard({ article, onQuote, voteTally, myVoteCounts }: ArticleCardProps) {
  const { user } = useAuth()
  const router = useRouter()
  const writerInfo = useWriterName(article.pubkey)
  const [replyCount, setReplyCount] = useState<number | null>(null)
  const wordCount = article.content.split(/\s+/).length
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const excerpt = article.summary || truncate(stripMarkdown(article.content), 200)

  useEffect(() => {
    repliesApi.getForTarget(article.id).then(d => setReplyCount(d.totalCount)).catch(() => {})
  }, [article.id])

  function handleCardClick() {
    router.push(`/article/${article.dTag}`)
  }

  function handleQuote(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    onQuote?.({
      eventId: article.id,
      eventKind: 30023,
      authorPubkey: article.pubkey,
      previewTitle: article.title,
      previewContent: article.summary,
      previewAuthorName: writerInfo?.displayName ?? article.pubkey.slice(0, 8) + '…',
    })
  }

  const authorHref = writerInfo?.username ? `/${writerInfo.username}` : null

  return (
    <div
      onClick={handleCardClick}
      style={{ background: '#FFFAEF', cursor: 'pointer' }}
      className="p-[22px_28px]"
    >
      {/* Writer name label */}
      {authorHref ? (
        <Link
          href={authorHref}
          onClick={(e) => e.stopPropagation()}
          style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8A8578', marginBottom: '10px', display: 'inline-block' }}
        >
          {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
        </Link>
      ) : (
        <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8A8578', marginBottom: '10px' }}>
          {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
        </p>
      )}

      {/* Headline — italic Literata */}
      <h2 style={{ fontFamily: '"Literata", Georgia, serif', fontSize: '26px', fontWeight: 500, fontStyle: 'italic', color: '#0F1F18', lineHeight: 1.2, letterSpacing: '-0.02em', marginBottom: '10px' }}>
        {article.title}
      </h2>

      {/* Excerpt — sans-serif */}
      <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '14.5px', fontWeight: 400, color: '#263D32', lineHeight: 1.6, marginBottom: '14px' }}>
        {excerpt}
      </p>

      {/* Metadata line */}
      <div className="flex items-center gap-3" style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', color: '#ACA69C' }}>
        <time dateTime={new Date(article.publishedAt * 1000).toISOString()}>{formatDate(article.publishedAt)}</time>
        <span style={{ opacity: 0.4 }}>/</span>
        <span>{readMinutes} min</span>
        {replyCount !== null && replyCount > 0 && (
          <><span style={{ opacity: 0.4 }}>/</span><span>{replyCount} {replyCount !== 1 ? 'replies' : 'reply'}</span></>
        )}
        {article.isPaywalled && article.pricePence && (
          <><span style={{ opacity: 0.4 }}>/</span><span style={{ color: '#B5242A' }}>£{(article.pricePence / 100).toFixed(2)}</span></>
        )}
        {user && onQuote && (
          <button
            onClick={handleQuote}
            className="text-content-faint hover:text-content-muted transition-colors"
            style={{ fontSize: '12px' }}
          >
            Quote
          </button>
        )}
        <span onClick={e => e.stopPropagation()}>
          <VoteControls
            targetEventId={article.id}
            targetKind={30023}
            isOwnContent={user?.pubkey === article.pubkey}
            initialTally={voteTally}
            initialMyVotes={myVoteCounts}
          />
        </span>
        <span onClick={e => e.stopPropagation()}>
          <ShareButton url={`/article/${article.dTag}`} title={article.title} />
        </span>
      </div>
    </div>
  )
}

function truncate(t: string, n: number) { return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '...' }
function stripMarkdown(md: string) {
  return md.replace(/^#{1,6}\s+/gm,'').replace(/\*\*(.+?)\*\*/g,'$1').replace(/\*(.+?)\*/g,'$1')
    .replace(/\[(.+?)\]\(.+?\)/g,'$1').replace(/!\[.*?\]\(.+?\)/g,'').replace(/\n+/g,' ').trim()
}
function formatDate(ts: number) {
  const d = new Date(ts*1000), now = new Date(), days = Math.floor((now.getTime()-d.getTime())/86400000)
  if (days===0) return 'Today'; if (days===1) return 'Yesterday'; if (days<7) return `${days}d ago`
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:d.getFullYear()!==now.getFullYear()?'numeric':undefined})
}
