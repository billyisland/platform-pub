'use client'

import type { FeedItem, ArticleEvent, NoteEvent, ExternalFeedItem } from '../../lib/ndk'
import { useWriterName } from '../../hooks/useWriterName'
import { TrustPip } from '../ui/TrustPip'
import { formatDateRelative, truncateText, stripMarkdown } from '../../lib/format'

// VesselCard — card variant for inside a ⊔, medium-bright tokens.
// Wireframe grammar (Step 2 standard density): pip + author + standfirst.
// No avatars, no action strip — long-press surface comes in a later slice.

const TOKENS = {
  cardBg: '#F5F4F0',
  title: '#3A3A37',
  standfirst: '#7A7974',
  meta: '#9C9A94',
  crimson: '#B5242A',
}

interface Props {
  item: FeedItem
}

export function VesselCard({ item }: Props) {
  if (item.type === 'article') return <ArticleVesselCard article={item} />
  if (item.type === 'note') return <NoteVesselCard note={item} />
  return <ExternalVesselCard external={item} />
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ background: TOKENS.cardBg }}
      className="p-4"
    >
      {children}
    </div>
  )
}

function Byline({
  pipStatus,
  name,
  publishedAt,
  trailing,
}: {
  pipStatus?: 'known' | 'partial' | 'unknown'
  name: string
  publishedAt: number
  trailing?: React.ReactNode
}) {
  return (
    <div
      className="flex items-center gap-2 mb-2 font-mono text-[11px] uppercase tracking-[0.06em]"
      style={{ color: TOKENS.meta }}
    >
      <TrustPip status={pipStatus} />
      <span style={{ color: TOKENS.title }} className="font-medium">{name}</span>
      <span>·</span>
      <time dateTime={new Date(publishedAt * 1000).toISOString()}>
        {formatDateRelative(publishedAt)}
      </time>
      {trailing}
    </div>
  )
}

function ArticleVesselCard({ article }: { article: ArticleEvent }) {
  const writer = useWriterName(article.pubkey)
  const name = writer?.displayName ?? article.pubkey.slice(0, 12) + '…'
  const standfirst = article.summary || truncateText(stripMarkdown(article.content), 140)
  return (
    <CardShell>
      <Byline
        pipStatus={article.pipStatus}
        name={name}
        publishedAt={article.publishedAt}
        trailing={
          article.isPaywalled && article.pricePence ? (
            <>
              <span>·</span>
              <span style={{ color: TOKENS.crimson }}>
                £{(article.pricePence / 100).toFixed(2)}
              </span>
            </>
          ) : null
        }
      />
      <h3
        className="font-serif text-[17px] leading-[1.25] mb-1.5"
        style={{ color: TOKENS.title }}
      >
        {article.title}
      </h3>
      {standfirst && (
        <p className="text-[13px] leading-[1.45]" style={{ color: TOKENS.standfirst }}>
          {standfirst}
        </p>
      )}
    </CardShell>
  )
}

function NoteVesselCard({ note }: { note: NoteEvent }) {
  const writer = useWriterName(note.pubkey)
  const name = writer?.displayName ?? note.pubkey.slice(0, 12) + '…'
  return (
    <CardShell>
      <Byline pipStatus={note.pipStatus} name={name} publishedAt={note.publishedAt} />
      <p
        className="text-[13.5px] leading-[1.5] whitespace-pre-wrap"
        style={{ color: TOKENS.title }}
      >
        {truncateText(note.content, 220)}
      </p>
    </CardShell>
  )
}

interface NewUserItem {
  type: 'new_user'
  username: string
  displayName: string | null
  avatar: string | null
  joinedAt: number
}

export function NewUserVesselCard({ item }: { item: NewUserItem }) {
  const name = item.displayName ?? item.username ?? 'Someone'
  return (
    <CardShell>
      <div
        className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.06em]"
        style={{ color: TOKENS.meta }}
      >
        <span style={{ color: TOKENS.title }} className="font-medium">
          {name}
        </span>
        <span>·</span>
        <time dateTime={new Date(item.joinedAt * 1000).toISOString()}>
          {formatDateRelative(item.joinedAt)}
        </time>
      </div>
      <p
        className="text-[13px] leading-[1.45] mt-1.5"
        style={{ color: TOKENS.standfirst }}
      >
        joined the platform
      </p>
    </CardShell>
  )
}

function ExternalVesselCard({ external }: { external: ExternalFeedItem }) {
  const name = external.authorName ?? external.authorHandle ?? external.sourceName ?? 'External'
  const protocol = external.sourceProtocol.toUpperCase()
  const body = external.title ?? external.summary ?? external.contentText ?? ''
  return (
    <CardShell>
      <Byline
        pipStatus={external.pipStatus}
        name={name}
        publishedAt={external.publishedAt}
        trailing={
          <>
            <span>·</span>
            <span>VIA {protocol}</span>
          </>
        }
      />
      {body && (
        <p
          className="text-[13.5px] leading-[1.5]"
          style={{ color: TOKENS.title }}
        >
          {truncateText(body, 200)}
        </p>
      )}
    </CardShell>
  )
}
