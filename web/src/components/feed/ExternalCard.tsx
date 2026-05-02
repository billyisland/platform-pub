'use client'

import { formatDateRelative } from '../../lib/format'
import { TrustPip } from '../ui/TrustPip'
import { useAuth } from '../../stores/auth'
import { useCompose } from '../../stores/compose'

// =============================================================================
// ExternalCard — renders external feed items (RSS, Nostr, Bluesky, Mastodon)
//
// Visual treatment: unified chassis with grey-300 left bar, mono-caps byline,
// provenance badge inline in the byline. Replies route through the compose
// overlay.
// =============================================================================

interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'link'
  url: string
  thumbnail?: string
  alt?: string
  width?: number
  height?: number
  title?: string
  description?: string
}

export interface ExternalFeedItem {
  type: 'external'
  id: string
  sourceProtocol: string
  sourceItemUri: string
  authorName: string | null
  authorHandle: string | null
  authorAvatarUrl: string | null
  authorUri: string | null
  contentText: string | null
  contentHtml: string | null
  title: string | null
  summary: string | null
  sourceReplyUri?: string | null
  sourceQuoteUri?: string | null
  media: MediaAttachment[]
  publishedAt: number
  sourceName: string | null
  sourceAvatar: string | null
  pipStatus?: 'known' | 'partial' | 'unknown' | 'contested'
}

interface ExternalCardProps {
  item: ExternalFeedItem
}

const PROTOCOL_LABELS: Record<string, string> = {
  rss: 'VIA RSS',
  atproto: 'VIA BLUESKY',
  activitypub: 'VIA MASTODON',
  nostr_external: 'VIA NOSTR',
}

// Turn an at:// URI into the Bluesky web URL so "View original" actually
// opens something. The canonical identifier is the AT URI, but browsers
// can't follow it. Same treatment for author DIDs.
function atprotoWebUri(atUri: string): string | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/)
  if (!match) return null
  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`
}

function atprotoProfileUri(authorUri: string): string {
  return `https://bsky.app/profile/${authorUri}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function ExternalCard({ item }: ExternalCardProps) {
  const { user } = useAuth()
  const openCompose = useCompose((s) => s.open)

  const authorDisplay = item.authorName ?? item.sourceName ?? 'Unknown source'
  const badge = PROTOCOL_LABELS[item.sourceProtocol] ?? 'EXTERNAL'

  const isAtproto = item.sourceProtocol === 'atproto'
  const viewOriginalUri = isAtproto
    ? atprotoWebUri(item.sourceItemUri) ?? item.sourceItemUri
    : item.sourceItemUri
  const authorWebUri = isAtproto && item.authorUri
    ? atprotoProfileUri(item.authorUri)
    : item.authorUri

  const imageMedia = item.media.filter(m => m.type === 'image')
  const linkEmbed = item.media.find(m => m.type === 'link')
  const videoMedia = item.media.find(m => m.type === 'video')
  const quoteWebUri = isAtproto && item.sourceQuoteUri ? atprotoWebUri(item.sourceQuoteUri) : null

  function handleReply() {
    openCompose('reply', {
      eventId: item.id,
      eventKind: 1,
      authorPubkey: '',
      previewContent: item.contentText?.slice(0, 200) ?? item.title ?? undefined,
      previewAuthorName: authorDisplay,
      previewTitle: item.title ?? undefined,
    })
  }

  return (
    <div style={{ borderLeft: '4px solid #BBBBBB', paddingLeft: '24px' }}>
      {/* Byline — mono-caps, unified with ArticleCard/NoteCard */}
      <div className="flex items-center gap-2 mb-2">
        <TrustPip status={item.pipStatus} />
        {authorWebUri ? (
          <a
            href={authorWebUri}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600 hover:text-black transition-colors truncate"
          >
            {authorDisplay}
          </a>
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600 truncate">
            {authorDisplay}
          </span>
        )}
        <span className="font-mono text-[11px] text-grey-600">&middot;</span>
        <span className="font-mono text-[11px] tracking-[0.02em] text-grey-600 flex-shrink-0">
          {formatDateRelative(item.publishedAt)}
        </span>
        <span className="font-mono text-[11px] text-grey-600">&middot;</span>
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-400 flex-shrink-0">
          {badge}
        </span>
        {item.sourceProtocol === 'activitypub' && (
          <span className="label-ui text-amber-600 flex-shrink-0" title="Mastodon outbox polling is best-effort — some posts may be missing depending on the instance">BETA</span>
        )}
      </div>

      {/* Title — Literata roman (italic is reserved for native articles) */}
      {item.title && (
        <h3 className="font-serif text-[20px] leading-[1.4] mt-1 text-black">
          {item.title}
        </h3>
      )}

      {/* Content — Literata summary when paired with a title (RSS-like),
          else Jost body matching NoteCard (Bluesky / Mastodon-like) */}
      {item.title ? (
        item.contentHtml ? (
          <div
            className="font-serif text-[14.5px] text-grey-600 leading-[1.5] mt-1.5 line-clamp-4 [&_a]:text-black [&_a]:underline [&_img]:hidden"
            dangerouslySetInnerHTML={{ __html: item.contentHtml }}
          />
        ) : item.contentText ? (
          <p className="font-serif text-[14.5px] text-grey-600 leading-[1.5] mt-1.5 line-clamp-4">
            {item.contentText}
          </p>
        ) : null
      ) : (
        item.contentHtml ? (
          <div
            className="font-sans text-[15px] text-black leading-[1.55] mt-1.5 [&_a]:text-black [&_a]:underline [&_img]:hidden"
            dangerouslySetInnerHTML={{ __html: item.contentHtml }}
          />
        ) : item.contentText ? (
          <p className="font-sans text-[15px] text-black leading-[1.55] mt-1.5 whitespace-pre-wrap">
            {item.contentText}
          </p>
        ) : null
      )}

      {/* Images */}
      {imageMedia.length > 0 && (
        <div className="mt-2.5 flex gap-2 overflow-x-auto">
          {imageMedia.slice(0, 4).map((m, i) => (
            <img
              key={i}
              src={m.url}
              alt={m.alt ?? ''}
              className="max-h-48 object-cover bg-grey-100"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ))}
        </div>
      )}

      {/* Video */}
      {videoMedia && (
        <a
          href={viewOriginalUri}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2.5 flex items-center gap-2 border border-grey-200 hover:border-grey-300 transition-colors px-3 py-2 no-underline"
        >
          <span className="label-ui text-grey-400">VIDEO</span>
          <span className="text-ui-xs text-grey-600">Watch on {isAtproto ? 'Bluesky' : 'source'}</span>
        </a>
      )}

      {/* Quoted post (Bluesky only for now) */}
      {quoteWebUri && (
        <a
          href={quoteWebUri}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2.5 block border-l-2 border-grey-300 pl-3 py-1 hover:border-black transition-colors no-underline"
        >
          <span className="label-ui text-grey-400">QUOTING</span>
          <span className="text-ui-xs text-grey-600 ml-2">View quoted post &rarr;</span>
        </a>
      )}

      {/* Link embed */}
      {linkEmbed && (
        <a
          href={linkEmbed.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2.5 flex gap-3 border border-grey-200 hover:border-grey-300 transition-colors p-2.5 no-underline"
        >
          {linkEmbed.thumbnail && (
            <img
              src={linkEmbed.thumbnail}
              alt=""
              className="w-16 h-16 object-cover bg-grey-100 flex-shrink-0"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="min-w-0 flex-1">
            {linkEmbed.title && (
              <p className="text-ui-sm font-semibold text-black truncate">{linkEmbed.title}</p>
            )}
            {linkEmbed.description && (
              <p className="text-ui-xs text-grey-600 line-clamp-2 mt-0.5">{linkEmbed.description}</p>
            )}
            <p className="text-mono-xs text-grey-400 truncate mt-0.5">{hostOf(linkEmbed.url)}</p>
          </div>
        </a>
      )}

      {/* Footer — actions */}
      <div className="mt-3 flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-600">
        {user && (
          <button
            onClick={handleReply}
            className="hover:text-black transition-colors"
          >
            Reply
          </button>
        )}
        <span className="flex-1" />
        <a
          href={viewOriginalUri}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-black transition-colors"
        >
          View original &nearr;
        </a>
      </div>
    </div>
  )
}
