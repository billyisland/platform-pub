'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { useCompose } from '../../stores/compose'
import { publishNote, type QuoteTarget } from '../../lib/publishNote'
import { useMediaAttachments } from '../../hooks/useMediaAttachments'
import { useLinkedAccounts } from '../../hooks/useLinkedAccounts'
import { MediaPreview } from '../ui/MediaPreview'
import type { LinkedAccount } from '../../lib/api'
import { ArticleComposePanel } from './ArticleComposePanel'

const NOTE_CHAR_LIMIT = 1000

export function ComposeOverlay() {
  const { user } = useAuth()
  const { isOpen, mode, replyTarget, close, onPublished, setMode } = useCompose()
  const [content, setContent] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const [crossPostIds, setCrossPostIds] = useState<Set<string>>(new Set())
  const ref = useRef<HTMLTextAreaElement>(null)
  const media = useMediaAttachments()
  const linkedAccounts = useLinkedAccounts()
  const scrimRef = useRef<HTMLDivElement>(null)
  const [scrimVisible, setScrimVisible] = useState(false)

  // Focus textarea on open
  useEffect(() => {
    if (isOpen) {
      setScrimVisible(true)
      setTimeout(() => ref.current?.focus(), 10)
    } else {
      // Reset state when closed
      setContent('')
      setPublishing(false)
      setError(null)
      setConfirmDismiss(false)
      setCrossPostIds(new Set())
      media.reset()
      setScrimVisible(false)
    }
  }, [isOpen])

  // Escape key handling (note/reply only — article mode manages its own dismiss via the ×)
  useEffect(() => {
    if (!isOpen || mode === 'article') return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleDismiss()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, mode, content, confirmDismiss])

  const hasContent = content.trim().length > 0 || media.attachments.filter(a => a.type === 'image').length > 0

  function handleDismiss() {
    if (hasContent && !confirmDismiss) {
      setConfirmDismiss(true)
      return
    }
    setConfirmDismiss(false)
    close()
  }

  function handleScrimClick(e: React.MouseEvent) {
    if (e.target === scrimRef.current) {
      handleDismiss()
    }
  }

  const charCount = media.totalCharCount(content)
  const isOver = charCount > NOTE_CHAR_LIMIT
  const isEmpty = !hasContent
  const canPost = !isEmpty && !isOver && !publishing

  const handlePost = useCallback(async () => {
    if (!canPost || !user) return
    setPublishing(true)
    setError(null)
    try {
      const finalContent = media.buildContent(content)
      const result = await publishNote(
        finalContent,
        user.pubkey,
        replyTarget ?? undefined,
      )
      // Notify the feed
      onPublished?.({
        type: 'note',
        id: result.noteEventId,
        pubkey: user.pubkey,
        content: finalContent,
        publishedAt: Math.floor(Date.now() / 1000),
        quotedEventId: replyTarget?.eventId,
      })
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post.')
    } finally {
      setPublishing(false)
    }
  }, [canPost, user, content, media, replyTarget, onPublished, close])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setContent(val)
    setConfirmDismiss(false)
    media.detectEmbeds(val)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handlePost()
    }
  }

  function toggleCrossPost(accountId: string) {
    setCrossPostIds(prev => {
      const next = new Set(prev)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
  }

  if (!isOpen || !user) return null

  const displayError = error ?? media.error
  const validAccounts = (linkedAccounts ?? []).filter(a => a.isValid)

  return (
    <>
      {/* Scrim */}
      <div
        ref={scrimRef}
        onClick={handleScrimClick}
        className="fixed inset-0 z-40 bg-black/40"
        style={{
          top: '60px',
          transition: scrimVisible ? 'none' : 'opacity 150ms ease-out',
          opacity: scrimVisible ? 1 : 0,
        }}
      />

      {/* Desktop overlay / Mobile sheet */}
      <div className="fixed inset-0 z-50 flex items-start justify-center pointer-events-none" style={{ top: '60px' }}>

        {/* Desktop overlay */}
        <div
          className={`hidden md:flex flex-col bg-white pointer-events-auto w-full mt-[20px] ${mode === 'article' ? 'max-w-[760px]' : 'max-w-[640px]'}`}
          style={{
            borderTop: '6px solid #111111',
            maxHeight: 'calc(100vh - 140px)',
          }}
        >
          {mode === 'article' ? (
            <ArticleComposePanel />
          ) : (
          <>
          {/* Top zone */}
          <div className="px-6 py-3" style={{ borderBottom: '4px solid #E5E5E5' }}>
            {mode === 'reply' && replyTarget ? (
              <ReplyPreview target={replyTarget} onClear={() => close()} />
            ) : (
              <span className="label-ui text-grey-400">NOTE</span>
            )}
          </div>

          {/* Editing zone */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <textarea
              ref={ref}
              value={content}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={mode === 'reply' ? 'Add your thoughts...' : "What's on your mind?"}
              rows={4}
              className="w-full resize-none bg-transparent font-sans text-[16px] text-black placeholder:text-grey-400 focus:outline-none leading-[1.6] border-none"
            />
            <MediaPreview
              attachments={media.attachments}
              onRemove={media.removeAttachment}
              uploading={media.uploading}
            />
          </div>

          {/* Controls zone */}
          <div className="px-6 py-3 flex items-center gap-4" style={{ borderTop: '4px solid #E5E5E5' }}>
            {/* Image upload */}
            <button
              onClick={media.triggerImageUpload}
              disabled={media.uploading}
              className="text-grey-600 hover:text-black disabled:opacity-40 transition-colors"
              title="Add image"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                <circle cx="5.5" cy="5.5" r="1" />
                <path d="M14.5 10.5L11 7L3.5 14.5" />
              </svg>
            </button>

            {/* Cross-post toggle */}
            {validAccounts.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="label-ui text-grey-400">ALSO POST TO:</span>
                {validAccounts.map(account => (
                  <CrossPostPill
                    key={account.id}
                    account={account}
                    active={crossPostIds.has(account.id)}
                    onToggle={() => toggleCrossPost(account.id)}
                  />
                ))}
              </div>
            )}

            <span className="flex-1" />

            {/* Character counter */}
            {charCount > 0 && (
              <span className={`font-mono text-[11px] transition-colors ${isOver ? 'text-crimson font-medium' : charCount > NOTE_CHAR_LIMIT - 50 ? 'text-crimson' : 'text-grey-600'}`}>
                {charCount}/{NOTE_CHAR_LIMIT}
              </span>
            )}

            {/* Mode switch: escalate a note-in-progress into an article */}
            {mode === 'note' && (
              <button
                type="button"
                onClick={() => setMode('article')}
                className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600 hover:text-black transition-colors"
              >
                Write an article &rarr;
              </button>
            )}

            {/* Post button */}
            <button
              onClick={handlePost}
              disabled={!canPost}
              className="btn disabled:opacity-30 py-1.5 px-5 text-[12px] font-sans font-semibold"
            >
              {publishing ? 'Posting\u2026' : 'Post'}
            </button>
          </div>

          {/* Error / confirm dismiss */}
          {(displayError || confirmDismiss) && (
            <div className="px-6 py-2" style={{ borderTop: '1px solid #F0F0F0' }}>
              {confirmDismiss && (
                <p className="text-ui-sm text-grey-600">Discard this? Press Escape again to confirm.</p>
              )}
              {displayError && (
                <div className="flex items-center justify-between">
                  <p className="text-ui-xs text-crimson">{displayError}</p>
                  <button onClick={() => { setError(null); media.clearError() }} className="text-grey-600 hover:text-crimson text-sm ml-2">&times;</button>
                </div>
              )}
            </div>
          )}
          </>
          )}

          {/* Close button */}
          <button
            onClick={mode === 'article' ? close : handleDismiss}
            className={`absolute top-[66px] text-grey-400 hover:text-black transition-colors text-lg leading-none z-50 ${mode === 'article' ? 'right-[calc(50%-368px)]' : 'right-[calc(50%-308px)]'}`}
            aria-label="Close compose"
          >
            &times;
          </button>
        </div>

        {/* Mobile sheet */}
        <div
          className="md:hidden flex flex-col bg-white pointer-events-auto w-full"
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            height: '90vh',
            borderTop: '6px solid #111111',
          }}
        >
          {/* Drag handle */}
          <div className="flex justify-center py-2">
            <div className="w-8 h-1 bg-black rounded-full" />
          </div>

          {mode === 'article' ? (
            <>
              <div className="flex items-center justify-between px-4 pb-2" style={{ borderBottom: '4px solid #E5E5E5' }}>
                <button onClick={close} className="text-grey-600 hover:text-black text-lg">&times;</button>
                <span className="label-ui text-grey-400">ARTICLE</span>
                <span className="w-6" />
              </div>
              <ArticleComposePanel />
            </>
          ) : (
          <>
          {/* Mobile chrome */}
          <div className="flex items-center justify-between px-4 pb-2" style={{ borderBottom: '4px solid #E5E5E5' }}>
            <button onClick={handleDismiss} className="text-grey-600 hover:text-black text-lg">&times;</button>
            <span className="label-ui text-grey-400">{mode === 'reply' ? 'REPLY' : 'NOTE'}</span>
            <button
              onClick={handlePost}
              disabled={!canPost}
              className="btn disabled:opacity-30 py-1 px-4 text-[12px] font-sans font-semibold"
            >
              {publishing ? 'Posting\u2026' : 'Post'}
            </button>
          </div>

          {/* Reply preview (mobile) */}
          {mode === 'reply' && replyTarget && (
            <div className="px-4 py-2" style={{ borderBottom: '4px solid #E5E5E5' }}>
              <ReplyPreview target={replyTarget} onClear={() => close()} />
            </div>
          )}

          {/* Editing zone (mobile) */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <textarea
              ref={ref}
              value={content}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={mode === 'reply' ? 'Add your thoughts...' : "What's on your mind?"}
              rows={6}
              className="w-full resize-none bg-transparent font-sans text-[16px] text-black placeholder:text-grey-400 focus:outline-none leading-[1.6] border-none"
            />
            <MediaPreview
              attachments={media.attachments}
              onRemove={media.removeAttachment}
              uploading={media.uploading}
            />
          </div>

          {/* Controls (mobile) */}
          <div className="px-4 py-3 flex items-center gap-3" style={{ borderTop: '4px solid #E5E5E5' }}>
            <button
              onClick={media.triggerImageUpload}
              disabled={media.uploading}
              className="text-grey-600 hover:text-black disabled:opacity-40 transition-colors"
              title="Add image"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                <circle cx="5.5" cy="5.5" r="1" />
                <path d="M14.5 10.5L11 7L3.5 14.5" />
              </svg>
            </button>
            <span className="flex-1" />
            {charCount > 0 && (
              <span className={`font-mono text-[11px] ${isOver ? 'text-crimson font-medium' : 'text-grey-600'}`}>
                {charCount}/{NOTE_CHAR_LIMIT}
              </span>
            )}
          </div>

          {/* Error / confirm (mobile) */}
          {(displayError || confirmDismiss) && (
            <div className="px-4 py-2" style={{ borderTop: '1px solid #F0F0F0' }}>
              {confirmDismiss && (
                <p className="text-ui-sm text-grey-600">Discard this? Press Escape again to confirm.</p>
              )}
              {displayError && (
                <p className="text-ui-xs text-crimson">{displayError}</p>
              )}
            </div>
          )}
          </>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Reply preview ─────────────────────────────────────────────────────────

function ReplyPreview({ target, onClear }: { target: QuoteTarget; onClear: () => void }) {
  return (
    <div className="flex items-start gap-2" style={{ borderLeft: '4px solid #B5242A', paddingLeft: '16px' }}>
      <div className="flex-1 min-w-0">
        {target.highlightedText ? (
          <>
            <p className="font-serif italic text-[14px] text-grey-600 leading-[1.5] line-clamp-3">
              {target.highlightedText.trim().split(/\s+/).slice(0, 80).join(' ')}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-grey-600 mt-1">
              {target.previewTitle && <span>{target.previewTitle}</span>}
              {target.previewTitle && target.previewAuthorName && ' \u2014 '}
              {target.previewAuthorName}
            </p>
          </>
        ) : (
          <>
            <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-grey-400">
              {target.previewAuthorName ?? target.authorPubkey.slice(0, 10) + '\u2026'}
            </p>
            {target.previewTitle && (
              <p className="text-[13px] font-sans font-medium text-black leading-snug mt-0.5 line-clamp-1">
                {target.previewTitle}
              </p>
            )}
            {target.previewContent ? (
              <p className="text-[12px] font-sans text-grey-600 leading-relaxed line-clamp-2 mt-0.5">
                {target.previewContent}
              </p>
            ) : (
              <p className="text-[12px] font-sans text-grey-600 italic mt-0.5">Note</p>
            )}
          </>
        )}
      </div>
      <button
        onClick={onClear}
        className="text-grey-600 hover:text-grey-400 text-sm transition-colors flex-shrink-0"
        title="Remove"
      >
        &times;
      </button>
    </div>
  )
}

// ─── Cross-post pill ───────────────────────────────────────────────────────

const PROTOCOL_NAMES: Record<string, string> = {
  activitypub: 'MASTODON',
  atproto: 'BLUESKY',
  nostr_external: 'NOSTR',
}

function CrossPostPill({ account, active, onToggle }: { account: LinkedAccount; active: boolean; onToggle: () => void }) {
  const label = PROTOCOL_NAMES[account.protocol] ?? account.protocol.toUpperCase()
  return (
    <button
      onClick={onToggle}
      className={`label-ui px-2 py-0.5 transition-colors ${
        active
          ? 'bg-black text-white'
          : 'bg-grey-100 text-grey-400 hover:text-grey-600'
      }`}
    >
      {label}
    </button>
  )
}
