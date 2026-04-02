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
import { formatDateRelative, truncateText, stripMarkdown } from '../../lib/format'

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
  const excerpt = article.summary || truncateText(stripMarkdown(article.content), 200)

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
  const isPaid = article.isPaywalled

  return (
    <div
      onClick={handleCardClick}
      className="py-8 cursor-pointer border-b border-grey-200"
      style={{ borderLeft: isPaid ? '4px solid #B5242A' : '4px solid #E5E5E5', paddingLeft: '1.5rem', paddingRight: '1.5rem' }}
    >
      {/* Byline — Plex Mono caps */}
      {authorHref ? (
        <Link
          href={authorHref}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[12px] uppercase tracking-[0.06em] text-grey-400 hover:text-grey-600 transition-colors mb-2.5 inline-block"
        >
          {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
        </Link>
      ) : (
        <p className="font-mono text-[12px] uppercase tracking-[0.06em] text-grey-400 mb-2.5">
          {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
        </p>
      )}

      {/* Headline — Literata italic */}
      <h2 className="font-serif text-[24px] font-medium italic text-black leading-[1.2] tracking-[-0.02em] mb-2.5">
        {article.title}
      </h2>

      {/* Standfirst — Literata roman */}
      <p className="font-serif text-[15px] text-grey-600 leading-[1.6] mb-3.5">
        {excerpt}
      </p>

      {/* Metadata — Plex Mono caps */}
      <div className="flex items-center gap-3 font-mono text-[12px] uppercase tracking-[0.02em] text-grey-400">
        <time dateTime={new Date(article.publishedAt * 1000).toISOString()}>{formatDateRelative(article.publishedAt)}</time>
        <span className="opacity-60">/</span>
        <span>{readMinutes} min</span>
        {replyCount !== null && replyCount > 0 && (
          <><span className="opacity-60">/</span><span>{replyCount} {replyCount !== 1 ? 'replies' : 'reply'}</span></>
        )}
        {isPaid && article.pricePence && (
          <><span className="opacity-60">/</span><span className="text-crimson">£{(article.pricePence / 100).toFixed(2)}</span></>
        )}
        {user && onQuote && (
          <button
            onClick={handleQuote}
            className="text-grey-400 hover:text-black transition-colors"
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

