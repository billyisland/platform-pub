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
      className="group py-7 px-6 cursor-pointer bg-white border border-grey-200 rounded-sm mb-4 transition-all duration-200 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] hover:border-grey-300"
    >
      {/* Byline + date */}
      <div className="flex items-center gap-2 mb-3">
        {authorHref ? (
          <Link
            href={authorHref}
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[12px] uppercase tracking-[0.06em] text-grey-400 hover:text-grey-600 transition-colors"
          >
            {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
          </Link>
        ) : (
          <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-grey-400">
            {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
          </span>
        )}
        <span className="font-mono text-[12px] text-grey-300">·</span>
        <time
          dateTime={new Date(article.publishedAt * 1000).toISOString()}
          className="font-mono text-[12px] tracking-[0.02em] text-grey-300"
        >
          {formatDateRelative(article.publishedAt)}
        </time>
        {isPaid && article.pricePence && (
          <>
            <span className="font-mono text-[12px] text-grey-300">·</span>
            <span className="font-mono text-[12px] tracking-[0.02em] text-crimson">£{(article.pricePence / 100).toFixed(2)}</span>
          </>
        )}
      </div>

      {/* Headline — Literata italic */}
      <h2 className="font-serif text-[22px] font-medium italic text-black leading-[1.25] tracking-[-0.02em] mb-2 group-hover:text-crimson-dark transition-colors">
        {article.title}
      </h2>

      {/* Standfirst — Literata roman */}
      <p className="font-serif text-[15px] text-grey-500 leading-[1.65] mb-4">
        {excerpt}
      </p>

      {/* Footer — read time, replies, actions */}
      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-300">
        <span>{readMinutes} min read</span>
        {replyCount !== null && replyCount > 0 && (
          <><span className="opacity-50">·</span><span>{replyCount} {replyCount !== 1 ? 'replies' : 'reply'}</span></>
        )}
        <span className="flex-1" />
        {user && onQuote && (
          <button
            onClick={handleQuote}
            className="text-grey-300 hover:text-black transition-colors"
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

