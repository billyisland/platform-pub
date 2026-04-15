'use client'

import { useEffect, useState } from 'react'
import { formatDateRelative } from '../../lib/format'
import { useAuth } from '../../stores/auth'
import { useLinkedAccounts } from '../../hooks/useLinkedAccounts'
import { publishNote } from '../../lib/publishNote'
import type { LinkedAccount } from '../../lib/api'

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

const PROTOCOL_PLATFORM_NAME: Record<string, string> = {
  rss: 'RSS',
  atproto: 'Bluesky',
  activitypub: 'Mastodon',
  nostr_external: 'Nostr',
}

export function ExternalCard({ item }: ExternalCardProps) {
  const { user } = useAuth()
  const linkedAccounts = useLinkedAccounts()
  const [composerMode, setComposerMode] = useState<null | 'reply' | 'quote'>(null)
  const [composerText, setComposerText] = useState('')
  const [crossPost, setCrossPost] = useState(false)
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [postedFlash, setPostedFlash] = useState(false)

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
            referrerPolicy="no-referrer"
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
                  referrerPolicy="no-referrer"
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
          <div className="mt-3 flex items-center gap-4">
            <a
              href={viewOriginalUri}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-text-muted hover:text-black transition-colors"
            >
              View original
            </a>
            {user && composerMode === null && (
              <>
                <button
                  onClick={() => { setComposerMode('reply'); setComposerText('') }}
                  className="btn-text-muted hover:text-black transition-colors"
                >
                  Reply
                </button>
                <button
                  onClick={() => { setComposerMode('quote'); setComposerText('') }}
                  className="btn-text-muted hover:text-black transition-colors"
                >
                  Quote
                </button>
              </>
            )}
            {postedFlash && (
              <span className="label-ui text-grey-400">Posted</span>
            )}
          </div>

          {/* Inline composer */}
          {composerMode !== null && (
            <ExternalReplyComposer
              mode={composerMode}
              text={composerText}
              onTextChange={setComposerText}
              crossPost={crossPost}
              onCrossPostChange={setCrossPost}
              linkedAccount={matchingLinkedAccount(linkedAccounts, item.sourceProtocol)}
              platformName={PROTOCOL_PLATFORM_NAME[item.sourceProtocol] ?? 'source'}
              posting={posting}
              error={postError}
              onCancel={() => { setComposerMode(null); setComposerText(''); setPostError(null) }}
              onPost={async () => {
                if (!user || posting) return
                setPosting(true); setPostError(null)
                try {
                  const matched = matchingLinkedAccount(linkedAccounts, item.sourceProtocol)
                  await publishNote(
                    composerText,
                    user.pubkey,
                    undefined,
                    crossPost && matched
                      ? { linkedAccountId: matched.id, sourceItemId: item.id, actionType: composerMode }
                      : undefined
                  )
                  setComposerMode(null)
                  setComposerText('')
                  setPostedFlash(true)
                  setTimeout(() => setPostedFlash(false), 2500)
                } catch (err) {
                  setPostError(err instanceof Error ? err.message : 'Failed to post')
                } finally {
                  setPosting(false)
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Inline composer — opens beneath an external card when the user clicks
// Reply or Quote. Cross-post toggle is shown only when the user has a linked
// account for the item's source protocol; for protocols we can't yet post
// back to (RSS), the toggle is hidden.
// -----------------------------------------------------------------------------

function matchingLinkedAccount(
  accounts: LinkedAccount[] | null,
  protocol: string
): LinkedAccount | null {
  if (!accounts) return null
  return accounts.find(a => a.protocol === protocol && a.isValid) ?? null
}

interface ComposerProps {
  mode: 'reply' | 'quote'
  text: string
  onTextChange: (v: string) => void
  crossPost: boolean
  onCrossPostChange: (v: boolean) => void
  linkedAccount: LinkedAccount | null
  platformName: string
  posting: boolean
  error: string | null
  onPost: () => void
  onCancel: () => void
}

function ExternalReplyComposer(props: ComposerProps) {
  const { mode, text, onTextChange, crossPost, onCrossPostChange, linkedAccount,
    platformName, posting, error, onPost, onCancel } = props

  // Initialise cross-post toggle from the linked account's default once,
  // when a linked account is first available.
  useEffect(() => {
    if (linkedAccount) onCrossPostChange(linkedAccount.crossPostDefault)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedAccount?.id])

  const placeholder = mode === 'reply'
    ? `Reply on all.haus${linkedAccount && crossPost ? ` and ${platformName}` : ''}…`
    : 'Add your thoughts…'

  return (
    <div className="mt-3 bg-grey-100 p-3">
      <textarea
        value={text}
        onChange={e => onTextChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        autoFocus
        className="w-full resize-none bg-transparent text-[14px] font-sans text-black placeholder:text-grey-400 focus:outline-none leading-relaxed"
      />
      <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
        {linkedAccount ? (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={crossPost}
              onChange={e => onCrossPostChange(e.target.checked)}
              className="cursor-pointer"
            />
            <span className="label-ui text-grey-500">
              Also post to {platformName} as {linkedAccount.externalHandle ?? linkedAccount.externalId}
            </span>
          </label>
        ) : (
          <span className="label-ui text-grey-300">
            Posts to all.haus only
          </span>
        )}
        <div className="flex items-center gap-3 ml-auto">
          <button onClick={onCancel} className="btn-text-muted">Cancel</button>
          <button
            onClick={onPost}
            disabled={posting || text.trim().length === 0}
            className="btn disabled:opacity-30 py-1.5 px-4 text-[12px] font-sans font-semibold"
          >
            {posting ? 'Posting…' : (mode === 'reply' ? 'Reply' : 'Post')}
          </button>
        </div>
      </div>
      {error && (
        <p className="mt-2 text-ui-xs text-crimson">{error}</p>
      )}
    </div>
  )
}
