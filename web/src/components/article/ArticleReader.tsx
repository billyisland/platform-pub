'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { PaywallGate } from './PaywallGate'
import { unwrapContentKey, decryptVaultContent } from '../../lib/vault'
import { getNdk, fetchVaultEvent } from '../../lib/ndk'
import { renderMarkdown } from '../../lib/markdown'
import { ReportButton } from '../ui/ReportButton'
import { ShareButton } from '../ui/ShareButton'
import { ReplySection } from '../replies/ReplySection'
import { AllowanceExhaustedModal } from '../ui/AllowanceExhaustedModal'
import { NoteComposer } from '../feed/NoteComposer'
import { articles as articlesApi } from '../../lib/api'
import type { ArticleEvent } from '../../lib/ndk'

interface ArticleReaderProps {
  article: ArticleEvent
  writerName: string
  writerUsername: string
  writerAvatar?: string
}

// Extract first image from markdown content
function extractHeroImage(content: string): string | null {
  const mdMatch = content.match(/^!\[.*?\]\((.+?)\)/m)
  if (mdMatch) return mdMatch[1]
  const urlMatch = content.match(/^(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?)$/m)
  if (urlMatch) return urlMatch[1]
  const blossomMatch = content.match(/^(https?:\/\/\S+\/[a-f0-9]{64}(?:\.webp)?)\s*$/m)
  if (blossomMatch) return blossomMatch[1]
  return null
}

// Strip the hero image from content so it's not rendered twice
function stripHeroImage(content: string, heroUrl: string): string {
  return content
    .replace(new RegExp(`!\\[.*?\\]\\(${heroUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*`), '')
    .replace(new RegExp(`^${heroUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'), '')
    .trim()
}

export function ArticleReader({ article, writerName, writerUsername, writerAvatar }: ArticleReaderProps) {
  const { user } = useAuth()
  const [paywallBody, setPaywallBody] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [showAllowanceModal, setShowAllowanceModal] = useState(false)
  const [freeHtml, setFreeHtml] = useState<string>('')
  const [paywallHtml, setPaywallHtml] = useState<string>('')

  // Text-selection quote flow
  const articleBodyRef = useRef<HTMLDivElement>(null)
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string } | null>(null)
  const [quoteComposerText, setQuoteComposerText] = useState<string | null>(null)

  const handleMouseUp = useCallback(() => {
    if (!user) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { setSelectionPopup(null); return }
    const body = articleBodyRef.current
    if (!body) return
    // Check if selection is within the article body
    const range = sel.getRangeAt(0)
    if (!body.contains(range.commonAncestorContainer)) { setSelectionPopup(null); return }
    const rect = range.getBoundingClientRect()
    const words = sel.toString().trim().split(/\s+/).slice(0, 80).join(' ')
    setSelectionPopup({
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
      text: words,
    })
  }, [user])

  const heroImage = extractHeroImage(article.content)
  const contentWithoutHero = heroImage ? stripHeroImage(article.content, heroImage) : article.content

  useEffect(() => { renderMarkdown(contentWithoutHero).then(setFreeHtml) }, [contentWithoutHero])
  useEffect(() => { if (paywallBody) renderMarkdown(paywallBody).then(setPaywallHtml) }, [paywallBody])
  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseUp])
  useEffect(() => {
    if (!article.isPaywalled) return
    const cached = sessionStorage.getItem(`unlocked:${article.id}`)
    if (cached) setPaywallBody(cached)
  }, [article.id, article.isPaywalled])

  async function handleUnlock() {
    if (!user) { window.location.href = '/auth?mode=signup'; return }
    setUnlocking(true); setUnlockError(null)
    try {
      // Step 1: Call gate-pass first — records payment, issues key, and now
      // also returns the ciphertext from the server's vault_keys table.
      // This decouples decryption from the relay having the correct event.
      let gatePassResult
      try { gatePassResult = await articlesApi.gatePass(article.id) }
      catch (err: any) {
        if (err.status === 402) {
          setUnlockError(!user.hasPaymentMethod && user.freeAllowanceRemainingPence <= 0 ? 'Your free allowance has been used. Add a card.' : 'Payment required.')
          return
        }
        throw err
      }

      // Step 2: Resolve ciphertext from the best available source:
      //   a) Server response (vault_keys.ciphertext — most reliable)
      //   b) NIP-23 event payload tag (from relay, already in article state)
      //   c) Legacy kind 39701 vault event on relay (pre-spec §III.2 articles)
      let ciphertext: string | undefined = gatePassResult.ciphertext
        ?? article.encryptedPayload

      if (!ciphertext) {
        // Legacy fallback — try fetching a separate kind 39701 vault event
        const ndk = getNdk(); await ndk.connect()
        const vaultEvent = await fetchVaultEvent(ndk, article.dTag)
        if (vaultEvent) ciphertext = vaultEvent.ciphertext
      }

      if (!ciphertext) {
        setUnlockError('Could not find the encrypted content.')
        return
      }

      // Step 3: Unwrap the NIP-44 wrapped content key and decrypt
      const algorithm = (gatePassResult.algorithm ?? article.payloadAlgorithm ?? 'aes-256-gcm') as 'xchacha20poly1305' | 'aes-256-gcm'
      const contentKeyBase64 = await unwrapContentKey(gatePassResult.encryptedKey)
      const body = await decryptVaultContent(ciphertext, contentKeyBase64, algorithm)
      setPaywallBody(body)
      sessionStorage.setItem(`unlocked:${article.id}`, body)
      if (gatePassResult.allowanceJustExhausted) setShowAllowanceModal(true)
    } catch (err: any) {
      if (!unlockError) setUnlockError('Something went wrong. Please try again.')
    } finally { setUnlocking(false) }
  }

  const isUnlocked = !article.isPaywalled || paywallBody !== null
  const pricePounds = article.pricePence ? (article.pricePence / 100).toFixed(2) : null
  const publishDate = new Date(article.publishedAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const articleUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/article/${article.dTag}`
    : `/article/${article.dTag}`

  return (
    <div className="min-h-screen bg-surface">
      {showAllowanceModal && <AllowanceExhaustedModal onClose={() => setShowAllowanceModal(false)} />}

      {/* Text-selection quote popup */}
      {selectionPopup && (
        <div
          className="fixed z-50 bg-ink-900 text-white px-3 py-1.5 text-ui-xs rounded-sm shadow-lg"
          style={{ left: selectionPopup.x, top: selectionPopup.y, transform: 'translate(-50%, -100%)' }}
        >
          <button
            onMouseDown={e => {
              e.preventDefault()
              setQuoteComposerText(selectionPopup.text)
              setSelectionPopup(null)
            }}
          >
            Quote
          </button>
        </div>
      )}

      {/* Quote composer modal */}
      {quoteComposerText !== null && (
        <div
          className="fixed inset-0 z-50 bg-ink-900/60 flex items-center justify-center p-4"
          onClick={() => setQuoteComposerText(null)}
        >
          <div className="w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <NoteComposer
              quoteTarget={{
                eventId: article.id,
                eventKind: 30023,
                authorPubkey: article.pubkey,
                highlightedText: quoteComposerText,
                previewContent: quoteComposerText,
                previewTitle: article.title,
                previewAuthorName: writerName,
              }}
              onPublished={() => setQuoteComposerText(null)}
            />
          </div>
        </div>
      )}
      {/* Hero image with title overlay */}
      {heroImage ? (
        <div
          className="article-hero"
          style={{ backgroundImage: `url(${heroImage})` }}
        >
          <div className="article-hero-content">
            <div className="flex items-center gap-3 mb-4">
              {writerAvatar ? (
                <img src={writerAvatar} alt="" className="h-8 w-8 rounded-full object-cover ring-2 ring-white/20" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center text-xs font-medium bg-white/20 text-white rounded-full">
                  {writerName[0].toUpperCase()}
                </span>
              )}
              <div>
                <a href={`/${writerUsername}`} className="text-mono-sm font-medium text-white hover:opacity-80 transition-opacity">{writerName}</a>
                <p className="text-mono-xs text-white/60">{publishDate}</p>
              </div>
            </div>
            <h1 className="font-serif text-3xl font-medium leading-tight text-white sm:text-4xl" style={{ letterSpacing: '-0.025em' }}>
              {article.title}
            </h1>
            {article.summary && (
              <p className="font-serif text-xl text-white/80 italic leading-relaxed mt-4 mb-2">
                {article.summary}
              </p>
            )}
          </div>
        </div>
      ) : (
        /* Standard header — no hero image */
        <div className="mx-auto max-w-article px-6 pt-16 lg:pt-8 bg-surface-raised">
          <div className="mb-10 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {writerAvatar ? (
                <img src={writerAvatar} alt="" className="h-9 w-9 rounded-full object-cover" />
              ) : (
                <span className="flex h-9 w-9 items-center justify-center text-xs font-medium bg-surface-sunken text-content-muted">
                  {writerName[0].toUpperCase()}
                </span>
              )}
              <div>
                <a href={`/${writerUsername}`} className="text-mono-sm font-medium text-ink-900 hover:opacity-70 transition-opacity">{writerName}</a>
                <p className="text-mono-xs text-content-muted">{publishDate}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ShareButton url={articleUrl} title={article.title} />
              <ReportButton targetNostrEventId={article.id} />
            </div>
          </div>
          <h1 className="font-serif text-3xl font-medium leading-tight text-ink-900 sm:text-4xl mb-4" style={{ letterSpacing: '-0.025em' }}>{article.title}</h1>
          {article.summary && (
            <p className="font-serif text-xl text-content-secondary italic leading-relaxed mt-4 mb-2">
              {article.summary}
            </p>
          )}
          <div className="rule-accent mb-10 mt-10" />
        </div>
      )}

      {/* Article body */}
      <article className="mx-auto max-w-article px-6 py-8 bg-surface-raised">
        {heroImage && (
          <div className="flex items-center justify-between mb-8">
            <div />
            <div className="flex items-center gap-3">
              <ShareButton url={articleUrl} title={article.title} />
              <ReportButton targetNostrEventId={article.id} />
            </div>
          </div>
        )}

        <div ref={articleBodyRef} className="prose prose-lg prose-dropcap max-w-none" dangerouslySetInnerHTML={{ __html: freeHtml }} />

        {article.isPaywalled && !isUnlocked && (
          <PaywallGate pricePounds={pricePounds} freeAllowanceRemaining={user?.freeAllowanceRemainingPence ?? 0} hasPaymentMethod={user?.hasPaymentMethod ?? false} isLoggedIn={!!user} onUnlock={handleUnlock} unlocking={unlocking} error={unlockError} />
        )}

        {paywallBody && <div className="prose prose-lg max-w-none mt-10" dangerouslySetInnerHTML={{ __html: paywallHtml }} />}

        <div className="ornament mt-16 mb-12" />
        <ReplySection targetEventId={article.id} targetKind={30023} targetAuthorPubkey={article.pubkey} contentAuthorId={undefined} />
      </article>
    </div>
  )
}
