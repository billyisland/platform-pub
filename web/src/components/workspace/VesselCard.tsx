'use client'

import type { FeedItem, ArticleEvent, NoteEvent, ExternalFeedItem } from '../../lib/ndk'
import { useWriterName } from '../../hooks/useWriterName'
import { TrustPip } from '../ui/TrustPip'
import { formatDateRelative, truncateText, stripMarkdown } from '../../lib/format'
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

interface CardContext {
  density: Density
  palette: VesselPalette
}

interface Props {
  item: FeedItem
  density?: Density
  brightness?: Brightness
}

export function VesselCard({ item, density, brightness }: Props) {
  const ctx: CardContext = {
    density: density ?? DEFAULT_DENSITY,
    palette: PALETTES[brightness ?? DEFAULT_BRIGHTNESS],
  }
  if (item.type === 'article') return <ArticleVesselCard article={item} ctx={ctx} />
  if (item.type === 'note') return <NoteVesselCard note={item} ctx={ctx} />
  return <ExternalVesselCard external={item} ctx={ctx} />
}

function CardShell({
  ctx,
  children,
}: {
  ctx: CardContext
  children: React.ReactNode
}) {
  // Compact density compresses the surface — single-line cards feel airless
  // with full padding. Standard / full keep the slice-1 padding.
  const padding = ctx.density === 'compact' ? '8px 12px' : '16px'
  return (
    <div style={{ background: ctx.palette.cardBg, padding }}>{children}</div>
  )
}

function CompactRow({
  pipStatus,
  title,
  trailing,
  ctx,
}: {
  pipStatus?: 'known' | 'partial' | 'unknown'
  title: string
  trailing?: React.ReactNode
  ctx: CardContext
}) {
  // 9px inline pip per Step 2 compact-density spec. TrustPip's smallest
  // canonical size is 11px; we wrap and scale it down with transform so the
  // pip code stays a single source of truth.
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
          opacity: ctx.palette.pipOpacity,
        }}
      >
        <span style={{ transform: 'scale(0.82)', transformOrigin: 'top left' }}>
          <TrustPip status={pipStatus} />
        </span>
      </span>
      <span className="truncate flex-1">{title}</span>
      {trailing}
    </div>
  )
}

function Byline({
  pipStatus,
  name,
  publishedAt,
  trailing,
  ctx,
}: {
  pipStatus?: 'known' | 'partial' | 'unknown'
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
      <span style={{ display: 'inline-flex', opacity: ctx.palette.pipOpacity }}>
        <TrustPip status={pipStatus} />
      </span>
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
}: {
  article: ArticleEvent
  ctx: CardContext
}) {
  const writer = useWriterName(article.pubkey)
  const name = writer?.displayName ?? article.pubkey.slice(0, 12) + '…'
  const standfirst = article.summary || truncateText(stripMarkdown(article.content), 140)
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

  if (ctx.density === 'compact') {
    return (
      <CardShell ctx={ctx}>
        <CompactRow
          pipStatus={article.pipStatus}
          title={article.title}
          trailing={pricePill}
          ctx={ctx}
        />
      </CardShell>
    )
  }

  return (
    <CardShell ctx={ctx}>
      <Byline
        pipStatus={article.pipStatus}
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
    </CardShell>
  )
}

function NoteVesselCard({ note, ctx }: { note: NoteEvent; ctx: CardContext }) {
  const writer = useWriterName(note.pubkey)
  const name = writer?.displayName ?? note.pubkey.slice(0, 12) + '…'

  if (ctx.density === 'compact') {
    return (
      <CardShell ctx={ctx}>
        <CompactRow
          pipStatus={note.pipStatus}
          title={truncateText(note.content, 90)}
          ctx={ctx}
        />
      </CardShell>
    )
  }

  return (
    <CardShell ctx={ctx}>
      <Byline
        pipStatus={note.pipStatus}
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
        <CompactRow title={`${name} joined`} ctx={ctx} />
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
}: {
  external: ExternalFeedItem
  ctx: CardContext
}) {
  const name =
    external.authorName ?? external.authorHandle ?? external.sourceName ?? 'External'
  const protocol = external.sourceProtocol.toUpperCase()
  const body = external.title ?? external.summary ?? external.contentText ?? ''

  if (ctx.density === 'compact') {
    return (
      <CardShell ctx={ctx}>
        <CompactRow
          pipStatus={external.pipStatus}
          title={body || name}
          ctx={ctx}
        />
      </CardShell>
    )
  }

  return (
    <CardShell ctx={ctx}>
      <Byline
        pipStatus={external.pipStatus}
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
    </CardShell>
  )
}
