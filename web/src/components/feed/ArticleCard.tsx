'use client'

import { useState, useEffect, useRef } from 'react'
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

function applySwallowtail(el: HTMLElement) {
  const w = el.offsetWidth
  const h = el.offsetHeight
  if (w === 0 || h === 0) return
  const forkDepth = 40
  const vX = ((w - forkDepth) / w) * 100
  el.style.clipPath = `polygon(0% 0%, 100% 0%, ${vX}% 50%, 100% 100%, 0% 100%)`
}

// Ghost pill style for the cream (light) background
const lightPillStyle: React.CSSProperties = {
  fontFamily: '"Source Sans 3", system-ui, sans-serif',
  fontSize: '12px',
  color: '#7A7774',
  background: 'rgba(17,17,17,0.03)',
  border: '1px solid rgba(17,17,17,0.1)',
  borderRadius: '20px',
  padding: '4px 14px',
  cursor: 'pointer',
  transition: 'background 0.15s ease, color 0.15s ease',
}

export function ArticleCard({ article, onQuote, voteTally, myVoteCounts }: ArticleCardProps) {
  const { user } = useAuth()
  const router = useRouter()
  const writerInfo = useWriterName(article.pubkey)
  const [replyCount, setReplyCount] = useState<number | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const wordCount = article.content.split(/\s+/).length
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const excerpt = article.summary || truncate(stripMarkdown(article.content), 200)
  const heroImage = extractFirstImage(article.content)

  useEffect(() => {
    repliesApi.getForTarget(article.id).then(d => setReplyCount(d.totalCount)).catch(() => {})
  }, [article.id])

  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    function run() { applySwallowtail(el!) }
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.ready.then(run)
    } else {
      run()
    }
    window.addEventListener('resize', run)
    return () => window.removeEventListener('resize', run)
  }, [excerpt, heroImage])

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

  const cardStyle: React.CSSProperties = {
    background: '#FAF7F2',
    borderRadius: 0,
    borderLeft: article.isPaywalled ? '6px solid #9B1C20' : 'none',
    cursor: 'pointer',
    overflow: 'hidden',
  }

  return (
    <div ref={cardRef} onClick={handleCardClick} style={cardStyle}>
      {heroImage ? (
        <div
          className="relative flex flex-col justify-end"
          style={{
            backgroundImage: `url(${heroImage})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            minHeight: '220px',
            paddingLeft: '24px',
            paddingRight: '58px',
            paddingTop: '24px',
            paddingBottom: '24px',
          }}
        >
          <div className="absolute inset-0 bg-gradient-to-t from-ink-900/80 via-ink-900/40 to-transparent" />
          <div className="relative z-10">
            {authorHref ? (
              <Link
                href={authorHref}
                onClick={(e) => e.stopPropagation()}
                style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(245,240,232,0.7)', marginBottom: '8px', display: 'inline-block' }}
              >
                {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
              </Link>
            ) : (
              <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(245,240,232,0.7)', marginBottom: '8px' }}>
                {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
              </p>
            )}
            <h2 style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: '28px', fontWeight: 600, color: '#FFFFFF', lineHeight: 1.2, marginBottom: '8px' }}>
              {article.title}
            </h2>
            <div className="flex items-center gap-3" style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
              <time dateTime={new Date(article.publishedAt * 1000).toISOString()}>{formatDate(article.publishedAt)}</time>
              <span style={{ opacity: 0.4 }}>/</span>
              <span>{readMinutes} min</span>
              {article.isPaywalled && (<><span style={{ opacity: 0.4 }}>/</span><span style={{ color: 'rgba(245,240,232,0.8)' }}>&pound;</span></>)}
              {user && onQuote && (
                <button onClick={handleQuote} style={lightPillStyle}>Quote</button>
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
        </div>
      ) : (
        <div style={{ padding: '20px 58px 20px 24px' }}>
          {authorHref ? (
            <Link
              href={authorHref}
              onClick={(e) => e.stopPropagation()}
              style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7A7774', marginBottom: '10px', display: 'inline-block' }}
            >
              {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
            </Link>
          ) : (
            <p style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7A7774', marginBottom: '10px' }}>
              {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
            </p>
          )}
          <h2 style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: '28px', fontWeight: 600, color: '#111111', lineHeight: 1.2, marginBottom: '8px' }}>
            {article.title}
          </h2>
          <p style={{ fontFamily: '"Newsreader", Georgia, serif', fontSize: '18px', fontWeight: 400, color: '#4A4845', lineHeight: 1.5, marginBottom: '14px' }}>
            {excerpt}
          </p>
          <div className="flex items-center gap-3" style={{ fontFamily: '"Source Sans 3", system-ui, sans-serif', fontSize: '12px', color: '#7A7774' }}>
            <time dateTime={new Date(article.publishedAt * 1000).toISOString()}>{formatDate(article.publishedAt)}</time>
            <span style={{ opacity: 0.4 }}>/</span>
            <span>{readMinutes} min</span>
            {replyCount !== null && replyCount > 0 && (
              <><span style={{ opacity: 0.4 }}>/</span><span>{replyCount} {replyCount !== 1 ? 'replies' : 'reply'}</span></>
            )}
            {article.isPaywalled && (
              <><span style={{ opacity: 0.4 }}>/</span><span style={{ color: '#9B1C20' }}>&pound;</span></>
            )}
            {user && onQuote && (
              <button
                onClick={handleQuote}
                style={lightPillStyle}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(17,17,17,0.07)'
                  ;(e.currentTarget as HTMLButtonElement).style.color = '#4A4845'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(17,17,17,0.03)'
                  ;(e.currentTarget as HTMLButtonElement).style.color = '#7A7774'
                }}
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
      )}
    </div>
  )
}

function extractFirstImage(content: string): string | null {
  const mdMatch = content.match(/!\[.*?\]\((.+?)\)/)
  if (mdMatch) return mdMatch[1]
  const urlMatch = content.match(/^(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?)$/m)
  if (urlMatch) return urlMatch[1]
  const blossomMatch = content.match(/(https?:\/\/\S+\/[a-f0-9]{64}(?:\.webp)?)/)
  if (blossomMatch) return blossomMatch[1]
  return null
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
