'use client'

import { useRouter } from 'next/navigation'
import type { FeedItem, ArticleEvent, NoteEvent, ExternalFeedItem } from '../../lib/ndk'
import type { PipStatus } from '../../lib/ndk'
import { useAuth } from '../../stores/auth'
import { useWriterName } from '../../hooks/useWriterName'
import { TrustPip } from '../ui/TrustPip'
import { VoteControls } from '../ui/VoteControls'
import { formatDateRelative, truncateText, stripMarkdown } from '../../lib/format'
import type { ReplyTarget } from './Composer'
import { PipTrigger } from './PipTrigger'
import { ReplySection } from '../replies/ReplySection'

export type PipOpen = (pubkey: string, rect: DOMRect, status: PipStatus | undefined) => void
import {
  PALETTES,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  type Brightness,
  type Density,
  type VesselPalette,
} from './tokens'

// VesselCard — card variant for inside a ⊔.
// Slice 1: medium-bright tokens, standard-density grammar.
// Slice 5c: density variants (compact / standard / full) + brightness-driven
// palette flowed in from the chassis. Compact = inline 9px pip + title.
// Standard = current. Full = current + source-attribution line.
// Slice 11: click-through to reader + action strip (vote / reply / share).
// Compact density stays action-less; standard + full render the strip.

interface CardContext {
  density: Density
  palette: VesselPalette
}

interface Props {
  item: FeedItem
  density?: Density
  brightness?: Brightness
  onReply?: (target: ReplyTarget) => void
  onPipOpen?: PipOpen
  // Slice 13: inline thread expansion state. Parent owns the toggle so
  // refresh ticks (after overlay-Composer replies) can target a specific
  // card without forcing the whole vessel to remount.
  threadExpanded?: boolean
  onToggleThread?: (target: ReplyTarget) => void
  threadRefreshKey?: number
  // Slice 20: save state + commit callback. Both come from the parent vessel
  // so a single savedIds Set drives the Save / Saved label across all cards
  // in the vessel without per-card state.
  isSaved?: boolean
  onToggleSave?: (feedItemId: string, next: boolean) => void
}

// at:// → bsky.app web URL. Mirrors the helper in feed/ExternalCard.tsx —
// kept local to avoid pulling in the deprecated card module.
function atprotoWebUri(atUri: string): string | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/)
  if (!match) return null
  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`
}

export function VesselCard({
  item,
  density,
  brightness,
  onReply,
  onPipOpen,
  threadExpanded,
  onToggleThread,
  threadRefreshKey,
  isSaved,
  onToggleSave,
}: Props) {
  const ctx: CardContext = {
    density: density ?? DEFAULT_DENSITY,
    palette: PALETTES[brightness ?? DEFAULT_BRIGHTNESS],
  }
  if (item.type === 'article')
    return (
      <ArticleVesselCard
        article={item}
        ctx={ctx}
        onReply={onReply}
        onPipOpen={onPipOpen}
        threadExpanded={threadExpanded}
        onToggleThread={onToggleThread}
        threadRefreshKey={threadRefreshKey}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
      />
    )
  if (item.type === 'note')
    return (
      <NoteVesselCard
        note={item}
        ctx={ctx}
        onReply={onReply}
        onPipOpen={onPipOpen}
        threadExpanded={threadExpanded}
        onToggleThread={onToggleThread}
        threadRefreshKey={threadRefreshKey}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
      />
    )
  return (
    <ExternalVesselCard
      external={item}
      ctx={ctx}
      isSaved={isSaved}
      onToggleSave={onToggleSave}
    />
  )
}

function CardShell({
  ctx,
  onClick,
  children,
}: {
  ctx: CardContext
  onClick?: () => void
  children: React.ReactNode
}) {
  // Compact density compresses the surface — single-line cards feel airless
  // with full padding. Standard / full keep the slice-1 padding.
  const padding = ctx.density === 'compact' ? '8px 12px' : '16px'
  return (
    <div
      onClick={onClick}
      style={{
        background: ctx.palette.cardBg,
        padding,
        cursor: onClick ? 'pointer' : undefined,
      }}
    >
      {children}
    </div>
  )
}

// Action strip under the card body. Quiet by default — mono-caps, hint-coloured —
// in keeping with the card chassis grammar. Compact density skips this row.
function CardActions({
  ctx,
  voteEventId,
  voteKind,
  isOwnContent,
  replyTarget,
  shareUrl,
  onReply,
  threadExpanded,
  onToggleThread,
  feedItemId,
  isSaved,
  onToggleSave,
}: {
  ctx: CardContext
  voteEventId?: string
  voteKind?: number
  isOwnContent?: boolean
  replyTarget?: ReplyTarget
  shareUrl?: string
  onReply?: (target: ReplyTarget) => void
  threadExpanded?: boolean
  onToggleThread?: (target: ReplyTarget) => void
  feedItemId?: string
  isSaved?: boolean
  onToggleSave?: (feedItemId: string, next: boolean) => void
}) {
  if (ctx.density === 'compact') return null

  function handleShare(e: React.MouseEvent) {
    e.stopPropagation()
    if (!shareUrl) return
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(shareUrl)
    }
  }

  // Slice 20: Save toggle. Crimson when saved (consistent with the rest of
  // the workspace's "committed" state colour). Suppressed if the item lacks
  // a feedItemId (e.g. surfaces that bypass the unified table).
  const canSave = !!feedItemId && !!onToggleSave

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-3 mt-3 font-mono text-[11px] uppercase tracking-[0.06em]"
      style={{ color: ctx.palette.cardMeta }}
    >
      {voteEventId && voteKind !== undefined && (
        <VoteControls
          targetEventId={voteEventId}
          targetKind={voteKind}
          isOwnContent={!!isOwnContent}
        />
      )}
      {replyTarget && onReply && (
        <button
          type="button"
          onClick={() => onReply(replyTarget)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: ctx.palette.cardMeta,
          }}
          className="hover:opacity-80"
        >
          Reply
        </button>
      )}
      {replyTarget && onToggleThread && (
        <button
          type="button"
          onClick={() => onToggleThread(replyTarget)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: ctx.palette.cardMeta,
          }}
          className="hover:opacity-80"
        >
          {threadExpanded ? 'Hide thread' : 'Thread'}
        </button>
      )}
      {shareUrl && (
        <button
          type="button"
          onClick={handleShare}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: ctx.palette.cardMeta,
          }}
          className="hover:opacity-80"
        >
          Share
        </button>
      )}
      {canSave && (
        <button
          type="button"
          onClick={() => onToggleSave!(feedItemId!, !isSaved)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: isSaved ? ctx.palette.crimson : ctx.palette.cardMeta,
          }}
          className="hover:opacity-80"
        >
          {isSaved ? 'Saved' : 'Save'}
        </button>
      )}
    </div>
  )
}

// Slice 13: inline playscript thread for vessel cards. Wraps the existing
// `ReplySection` (the source of truth for the playscript render + reply
// publish + vote tally pipeline) in a click-isolating shell so taps inside
// the thread don't bubble up to the card-level navigation. `compact` keeps
// ReplySection from drawing its own border-top + heading; the visual gap
// from the card body is provided by the `mt-4` here.
function CardThread({
  target,
  refreshKey,
}: {
  target: ReplyTarget
  refreshKey?: number
}) {
  return (
    <div onClick={(e) => e.stopPropagation()} className="mt-4">
      <ReplySection
        targetEventId={target.eventId}
        targetKind={target.eventKind}
        targetAuthorPubkey={target.authorPubkey}
        compact
        refreshKey={refreshKey}
      />
    </div>
  )
}

function CompactRow({
  pipNode,
  title,
  trailing,
  ctx,
}: {
  pipNode: React.ReactNode
  title: string
  trailing?: React.ReactNode
  ctx: CardContext
}) {
  return (
    <div
      className="flex items-center gap-2 font-sans text-[13px]"
      style={{ color: ctx.palette.cardTitle }}
    >
      <span
        style={{
          display: 'inline-flex',
          width: 9,
          height: 9,
        }}
      >
        {pipNode}
      </span>
      <span className="truncate flex-1">{title}</span>
      {trailing}
    </div>
  )
}

function Byline({
  pipNode,
  name,
  publishedAt,
  trailing,
  ctx,
}: {
  pipNode: React.ReactNode
  name: string
  publishedAt: number
  trailing?: React.ReactNode
  ctx: CardContext
}) {
  return (
    <div
      className="flex items-center gap-2 mb-2 font-mono text-[11px] uppercase tracking-[0.06em]"
      style={{ color: ctx.palette.cardMeta }}
    >
      {pipNode}
      <span style={{ color: ctx.palette.cardTitle }} className="font-medium">
        {name}
      </span>
      <span>·</span>
      <time dateTime={new Date(publishedAt * 1000).toISOString()}>
        {formatDateRelative(publishedAt)}
      </time>
      {trailing}
    </div>
  )
}

function SourceAttribution({
  protocol,
  identifier,
  ctx,
}: {
  protocol: string
  identifier?: string
  ctx: CardContext
}) {
  return (
    <div
      className="font-mono text-[10px] uppercase tracking-[0.06em] mt-2"
      style={{ color: ctx.palette.cardMeta }}
    >
      VIA {protocol}
      {identifier ? ` · ${identifier}` : ''}
    </div>
  )
}

function ArticleVesselCard({
  article,
  ctx,
  onReply,
  onPipOpen,
  threadExpanded,
  onToggleThread,
  threadRefreshKey,
  isSaved,
  onToggleSave,
}: {
  article: ArticleEvent
  ctx: CardContext
  onReply?: (target: ReplyTarget) => void
  onPipOpen?: PipOpen
  threadExpanded?: boolean
  onToggleThread?: (target: ReplyTarget) => void
  threadRefreshKey?: number
  isSaved?: boolean
  onToggleSave?: (feedItemId: string, next: boolean) => void
}) {
  const router = useRouter()
  const { user } = useAuth()
  const writer = useWriterName(article.pubkey)
  const name = writer?.displayName ?? article.pubkey.slice(0, 12) + '…'
  const standfirst = article.summary || truncateText(stripMarkdown(article.content), 140)
  const href = `/article/${article.dTag}`
  const shareUrl =
    typeof window !== 'undefined' ? `${window.location.origin}${href}` : href
  const isOwnContent = !!user && user.pubkey === article.pubkey
  const replyTarget: ReplyTarget = {
    eventId: article.id,
    eventKind: 30023,
    authorPubkey: article.pubkey,
    authorName: name,
    excerpt: article.title,
  }
  const onCardClick = () => router.push(href)
  const pricePill =
    article.isPaywalled && article.pricePence ? (
      ctx.density === 'compact' ? (
        <span style={{ color: ctx.palette.crimson, marginLeft: 4 }}>£</span>
      ) : (
        <>
          <span>·</span>
          <span style={{ color: ctx.palette.crimson }}>
            £{(article.pricePence / 100).toFixed(2)}
          </span>
        </>
      )
    ) : null

  const pipNodeCompact = onPipOpen ? (
    <PipTrigger
      pubkey={article.pubkey}
      pipStatus={article.pipStatus}
      opacity={ctx.palette.pipOpacity}
      scale={0.82}
      onOpen={onPipOpen}
    />
  ) : (
    <span style={{ opacity: ctx.palette.pipOpacity, transform: 'scale(0.82)', transformOrigin: 'top left' }}>
      <TrustPip status={article.pipStatus} />
    </span>
  )
  const pipNodeByline = onPipOpen ? (
    <PipTrigger
      pubkey={article.pubkey}
      pipStatus={article.pipStatus}
      opacity={ctx.palette.pipOpacity}
      onOpen={onPipOpen}
    />
  ) : (
    <span style={{ display: 'inline-flex', opacity: ctx.palette.pipOpacity }}>
      <TrustPip status={article.pipStatus} />
    </span>
  )

  if (ctx.density === 'compact') {
    return (
      <CardShell ctx={ctx} onClick={onCardClick}>
        <CompactRow
          pipNode={pipNodeCompact}
          title={article.title}
          trailing={pricePill}
          ctx={ctx}
        />
      </CardShell>
    )
  }

  return (
    <CardShell ctx={ctx} onClick={onCardClick}>
      <Byline
        pipNode={pipNodeByline}
        name={name}
        publishedAt={article.publishedAt}
        trailing={pricePill}
        ctx={ctx}
      />
      <h3
        className="font-serif text-[17px] leading-[1.25] mb-1.5"
        style={{ color: ctx.palette.cardTitle }}
      >
        {article.title}
      </h3>
      {standfirst && (
        <p
          className="text-[13px] leading-[1.45]"
          style={{ color: ctx.palette.cardStandfirst }}
        >
          {standfirst}
        </p>
      )}
      {ctx.density === 'full' && (
        <SourceAttribution
          protocol="ALL.HAUS"
          identifier={article.pubkey.slice(0, 12) + '…'}
          ctx={ctx}
        />
      )}
      <CardActions
        ctx={ctx}
        voteEventId={article.id}
        voteKind={30023}
        isOwnContent={isOwnContent}
        replyTarget={replyTarget}
        shareUrl={shareUrl}
        onReply={onReply}
        threadExpanded={threadExpanded}
        onToggleThread={onToggleThread}
        feedItemId={article.feedItemId}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
      />
      {threadExpanded && (
        <CardThread target={replyTarget} refreshKey={threadRefreshKey} />
      )}
    </CardShell>
  )
}

function NoteVesselCard({
  note,
  ctx,
  onReply,
  onPipOpen,
  threadExpanded,
  onToggleThread,
  threadRefreshKey,
  isSaved,
  onToggleSave,
}: {
  note: NoteEvent
  ctx: CardContext
  onReply?: (target: ReplyTarget) => void
  onPipOpen?: PipOpen
  threadExpanded?: boolean
  onToggleThread?: (target: ReplyTarget) => void
  threadRefreshKey?: number
  isSaved?: boolean
  onToggleSave?: (feedItemId: string, next: boolean) => void
}) {
  const { user } = useAuth()
  const writer = useWriterName(note.pubkey)
  const name = writer?.displayName ?? note.pubkey.slice(0, 12) + '…'
  const isOwnContent = !!user && user.pubkey === note.pubkey
  const replyTarget: ReplyTarget = {
    eventId: note.id,
    eventKind: 1,
    authorPubkey: note.pubkey,
    authorName: name,
    excerpt: truncateText(note.content, 120),
  }

  const pipNodeCompact = onPipOpen ? (
    <PipTrigger
      pubkey={note.pubkey}
      pipStatus={note.pipStatus}
      opacity={ctx.palette.pipOpacity}
      scale={0.82}
      onOpen={onPipOpen}
    />
  ) : (
    <span style={{ opacity: ctx.palette.pipOpacity, transform: 'scale(0.82)', transformOrigin: 'top left' }}>
      <TrustPip status={note.pipStatus} />
    </span>
  )
  const pipNodeByline = onPipOpen ? (
    <PipTrigger
      pubkey={note.pubkey}
      pipStatus={note.pipStatus}
      opacity={ctx.palette.pipOpacity}
      onOpen={onPipOpen}
    />
  ) : (
    <span style={{ display: 'inline-flex', opacity: ctx.palette.pipOpacity }}>
      <TrustPip status={note.pipStatus} />
    </span>
  )

  if (ctx.density === 'compact') {
    return (
      <CardShell ctx={ctx}>
        <CompactRow
          pipNode={pipNodeCompact}
          title={truncateText(note.content, 90)}
          ctx={ctx}
        />
      </CardShell>
    )
  }

  return (
    <CardShell ctx={ctx}>
      <Byline
        pipNode={pipNodeByline}
        name={name}
        publishedAt={note.publishedAt}
        ctx={ctx}
      />
      <p
        className="text-[13.5px] leading-[1.5] whitespace-pre-wrap"
        style={{ color: ctx.palette.cardTitle }}
      >
        {truncateText(note.content, 220)}
      </p>
      {ctx.density === 'full' && (
        <SourceAttribution
          protocol="NOSTR"
          identifier={note.pubkey.slice(0, 12) + '…'}
          ctx={ctx}
        />
      )}
      <CardActions
        ctx={ctx}
        voteEventId={note.id}
        voteKind={1}
        isOwnContent={isOwnContent}
        replyTarget={replyTarget}
        onReply={onReply}
        threadExpanded={threadExpanded}
        onToggleThread={onToggleThread}
        feedItemId={note.feedItemId}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
      />
      {threadExpanded && (
        <CardThread target={replyTarget} refreshKey={threadRefreshKey} />
      )}
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

export function NewUserVesselCard({
  item,
  density,
  brightness,
}: {
  item: NewUserItem
  density?: Density
  brightness?: Brightness
}) {
  const ctx: CardContext = {
    density: density ?? DEFAULT_DENSITY,
    palette: PALETTES[brightness ?? DEFAULT_BRIGHTNESS],
  }
  const name = item.displayName ?? item.username ?? 'Someone'

  if (ctx.density === 'compact') {
    return (
      <CardShell ctx={ctx}>
        <CompactRow pipNode={null} title={`${name} joined`} ctx={ctx} />
      </CardShell>
    )
  }

  return (
    <CardShell ctx={ctx}>
      <div
        className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.06em]"
        style={{ color: ctx.palette.cardMeta }}
      >
        <span style={{ color: ctx.palette.cardTitle }} className="font-medium">
          {name}
        </span>
        <span>·</span>
        <time dateTime={new Date(item.joinedAt * 1000).toISOString()}>
          {formatDateRelative(item.joinedAt)}
        </time>
      </div>
      <p
        className="text-[13px] leading-[1.45] mt-1.5"
        style={{ color: ctx.palette.cardStandfirst }}
      >
        joined the platform
      </p>
    </CardShell>
  )
}

function ExternalVesselCard({
  external,
  ctx,
  isSaved,
  onToggleSave,
}: {
  external: ExternalFeedItem
  ctx: CardContext
  isSaved?: boolean
  onToggleSave?: (feedItemId: string, next: boolean) => void
}) {
  const name =
    external.authorName ?? external.authorHandle ?? external.sourceName ?? 'External'
  const protocol = external.sourceProtocol.toUpperCase()
  const body = external.title ?? external.summary ?? external.contentText ?? ''
  // External items live at their source — atproto URIs need rewriting to
  // a browser-followable bsky.app URL; everything else is already a URL.
  const externalUrl =
    external.sourceProtocol === 'atproto'
      ? atprotoWebUri(external.sourceItemUri) ?? external.sourceItemUri
      : external.sourceItemUri
  const onCardClick = () => {
    if (typeof window !== 'undefined') {
      window.open(externalUrl, '_blank', 'noopener,noreferrer')
    }
  }

  const pipNodeCompact = (
    <span style={{ opacity: ctx.palette.pipOpacity, transform: 'scale(0.82)', transformOrigin: 'top left' }}>
      <TrustPip status={external.pipStatus} />
    </span>
  )
  const pipNodeByline = (
    <span style={{ display: 'inline-flex', opacity: ctx.palette.pipOpacity }}>
      <TrustPip status={external.pipStatus} />
    </span>
  )

  if (ctx.density === 'compact') {
    return (
      <CardShell ctx={ctx} onClick={onCardClick}>
        <CompactRow
          pipNode={pipNodeCompact}
          title={body || name}
          ctx={ctx}
        />
      </CardShell>
    )
  }

  return (
    <CardShell ctx={ctx} onClick={onCardClick}>
      <Byline
        pipNode={pipNodeByline}
        name={name}
        publishedAt={external.publishedAt}
        trailing={
          ctx.density === 'standard' ? (
            <>
              <span>·</span>
              <span>VIA {protocol}</span>
            </>
          ) : null
        }
        ctx={ctx}
      />
      {body && (
        <p
          className="text-[13.5px] leading-[1.5]"
          style={{ color: ctx.palette.cardTitle }}
        >
          {truncateText(body, 200)}
        </p>
      )}
      {ctx.density === 'full' && (
        <SourceAttribution
          protocol={protocol}
          identifier={external.authorHandle ?? external.sourceName ?? undefined}
          ctx={ctx}
        />
      )}
      <CardActions
        ctx={ctx}
        shareUrl={externalUrl}
        feedItemId={external.feedItemId}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
      />
    </CardShell>
  )
}
