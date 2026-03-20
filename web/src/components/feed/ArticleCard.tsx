'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { ArticleEvent } from '../../lib/ndk'
import { useWriterName } from '../../hooks/useWriterName'
import { replies as repliesApi } from '../../lib/api'

interface ArticleCardProps { article: ArticleEvent }

export function ArticleCard({ article }: ArticleCardProps) {
  const writerInfo = useWriterName(article.pubkey)
  const [replyCount, setReplyCount] = useState<number | null>(null)
  const wordCount = article.content.split(/\s+/).length
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const excerpt = article.summary || truncate(stripMarkdown(article.content), 200)

  // Extract hero image — first image URL in the content
  const heroImage = extractFirstImage(article.content)

  useEffect(() => {
    repliesApi.getForTarget(article.id).then(d => setReplyCount(d.totalCount)).catch(() => {})
  }, [article.id])

  return (
    <Link href={`/article/${article.dTag}`} className="group block overflow-hidden">
      {heroImage ? (
        // Card with hero image background
        <div
          className="relative p-6 min-h-[220px] flex flex-col justify-end"
          style={{
            backgroundImage: `url(${heroImage})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        >
          <div className="absolute inset-0 bg-gradient-to-t from-ink-900/80 via-ink-900/40 to-transparent" />
          <div className="relative z-10">
            <p className="label-ui text-accent-200 mb-2">{writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}</p>
            <h2 className="font-serif text-xl font-normal text-white group-hover:opacity-90 transition-opacity mb-2 leading-snug tracking-tight">
              {article.title}
            </h2>
            <div className="flex items-center gap-3 text-ui-xs text-white/60">
              <time dateTime={new Date(article.publishedAt * 1000).toISOString()}>{formatDate(article.publishedAt)}</time>
              <span className="opacity-40">/</span>
              <span>{readMinutes} min</span>
              {article.isPaywalled && (<><span className="opacity-40">/</span><span className="text-accent-300">&pound;</span></>)}
            </div>
          </div>
        </div>
      ) : (
        // Standard card — left accent border, serif excerpt
        <div className="bg-surface-raised p-5 border-l-[3px] border-accent">
          <p className="label-ui text-content-muted mb-3">
            {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + '...'}
          </p>
          <h2 className="font-serif text-xl font-normal text-content-primary group-hover:opacity-80 transition-opacity mb-2 leading-snug tracking-tight">
            {article.title}
          </h2>
          <p className="font-serif text-sm text-content-secondary leading-relaxed mb-4" style={{ lineHeight: '1.7' }}>
            {excerpt}
          </p>
          <div className="flex items-center gap-3 text-ui-xs text-content-muted">
            <time dateTime={new Date(article.publishedAt * 1000).toISOString()}>{formatDate(article.publishedAt)}</time>
            <span className="opacity-40">/</span>
            <span>{readMinutes} min</span>
            {replyCount !== null && replyCount > 0 && (
              <><span className="opacity-40">/</span><span>{replyCount} {replyCount !== 1 ? 'replies' : 'reply'}</span></>
            )}
            {article.isPaywalled && (
              <><span className="opacity-40">/</span><span className="text-accent">&pound;</span></>
            )}
          </div>
        </div>
      )}
    </Link>
  )
}

// Extract first image URL from markdown content
function extractFirstImage(content: string): string | null {
  // Match markdown image: ![alt](url)
  const mdMatch = content.match(/!\[.*?\]\((.+?)\)/)
  if (mdMatch) return mdMatch[1]
  // Match bare image URL on its own line
  const urlMatch = content.match(/^(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?)$/m)
  if (urlMatch) return urlMatch[1]
  // Match blossom hash URL
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
