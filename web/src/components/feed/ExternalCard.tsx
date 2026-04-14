'use client'

import { formatDateRelative } from '../../lib/format'

// =============================================================================
// ExternalCard — renders external feed items (RSS, Nostr, Bluesky, Mastodon)
//
// Visual treatment: similar to NoteCard but with provenance badge and
// "View original" link. Author name links to external profile, not
// an all.haus page.
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
  const authorDisplay = item.authorName ?? item.sourceName ?? 'Unknown source'
  const avatarUrl = item.authorAvatarUrl ?? item.sourceAvatar ?? null
  const initial = authorDisplay[0]?.toUpperCase() ?? '?'
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

  return (
    <div className="py-5 border-b border-grey-200">
      {/* Author row */}
      <div className="flex items-start gap-2.5">
        {/* Avatar */}
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={authorDisplay}
            className="w-7 h-7 object-cover flex-shrink-0 bg-grey-200"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div className="w-7 h-7 bg-grey-200 flex items-center justify-center flex-shrink-0">
            <span className="font-mono text-[11px] text-grey-400">{initial}</span>
          </div>
        )}

        <div className="flex-1 min-w-0">
          {/* Author name + timestamp */}
          <div className="flex items-baseline gap-2">
            {authorWebUri ? (
              <a
                href={authorWebUri}
                target="_blank"
                rel="noopener noreferrer"
                className="font-sans text-[14px] font-semibold text-black hover:opacity-70 transition-opacity truncate"
              >
                {authorDisplay}
              </a>
            ) : (
              <span className="font-sans text-[14px] font-semibold text-black truncate">
                {authorDisplay}
              </span>
            )}
            <span className="text-mono-xs text-grey-400 flex-shrink-0">
              {formatDateRelative(item.publishedAt)}
            </span>
          </div>

          {/* Provenance badge */}
          <span className="label-ui text-crimson">{badge}</span>

          {/* Title (RSS items often have one) */}
          {item.title && (
            <h3 className="font-serif italic text-[18px] leading-[1.4] mt-2 text-black">
              {item.title}
            </h3>
          )}

          {/* Content */}
          {item.contentHtml ? (
            <div
              className="text-ui-sm text-grey-600 mt-1.5 line-clamp-4 [&_a]:text-black [&_a]:underline [&_img]:hidden"
              dangerouslySetInnerHTML={{ __html: item.contentHtml }}
            />
          ) : item.contentText ? (
            <p className="text-ui-sm text-grey-600 mt-1.5 line-clamp-4">
              {item.contentText}
            </p>
          ) : null}

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
                />
              ))}
            </div>
          )}

          {/* Video (HLS — link out to source since browsers can't play it natively) */}
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
              <span className="text-ui-xs text-grey-600 ml-2">View quoted post →</span>
            </a>
          )}

          {/* Link embed (Bluesky external card / Mastodon link preview) */}
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

          {/* Footer — view original link */}
          <div className="mt-3 flex items-center gap-4">
            <a
              href={viewOriginalUri}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-text-muted hover:text-black transition-colors"
            >
              View original
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
