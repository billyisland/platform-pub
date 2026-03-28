'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
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
      let gatePassResult
      try { gatePassResult = await articlesApi.gatePass(article.id) }
      catch (err: any) {
        if (err.status === 402) {
          setUnlockError(!user.hasPaymentMethod && user.freeAllowanceRemainingPence <= 0 ? 'Your free allowance has been used. Add a card.' : 'Payment required.')
          return
        }
        throw err
      }

      let ciphertext: string | undefined = gatePassResult.ciphertext
        ?? article.encryptedPayload

      if (!ciphertext) {
        const ndk = getNdk(); await ndk.connect()
        const vaultEvent = await fetchVaultEvent(ndk, article.dTag)
        if (vaultEvent) ciphertext = vaultEvent.ciphertext
      }

      if (!ciphertext) {
        setUnlockError('Could not find the encrypted content.')
        return
      }

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
          className="fixed z-50 bg-ink text-white px-3 py-1.5 text-ui-xs shadow-lg"
          style={{ left: selectionPopup.x, top: selectionPopup.y, transform: 'translate(-50%, -100%)', borderRadius: '2px' }}
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
          className="fixed inset-0 z-50 bg-ink/60 flex items-center justify-center p-4"
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

      {/* Back link */}
      <div className="mx-auto max-w-article-frame px-6 pt-16 lg:pt-8 pb-4">
        <Link href="/feed" className="text-[13px] text-content-faint hover:text-content-muted transition-colors">
          ← Back to feed
        </Link>
      </div>

      {/* Parchment card containing the article */}
      <div className="mx-auto max-w-article-frame px-6">
        <div className="bg-card border-[3px] border-ink" style={{ padding: '40px 48px' }}>
          {/* Hero image inside the card if present */}
          {heroImage && (
            <div className="-mx-[48px] -mt-[40px] mb-8">
              <img src={heroImage} alt="" className="w-full max-h-[400px] object-cover" />
            </div>
          )}

          {/* Byline */}
          <div className="mb-8 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {writerAvatar ? (
                <img src={writerAvatar} alt="" className="h-9 w-9 rounded-full object-cover" />
              ) : (
                <span className="flex h-9 w-9 items-center justify-center text-xs font-medium bg-avatar-bg text-content-muted rounded-full">
                  {writerName[0].toUpperCase()}
                </span>
              )}
              <div>
                <a href={`/${writerUsername}`} className="text-sm font-semibold text-ink hover:opacity-70 transition-opacity">{writerName}</a>
                <p className="text-ui-xs text-content-card-faint">{publishDate}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ShareButton url={articleUrl} title={article.title} />
              <ReportButton targetNostrEventId={article.id} />
            </div>
          </div>

          {/* Title — italic Literata */}
          <h1
            className="mb-4"
            style={{
              fontFamily: '"Literata", Georgia, serif',
              fontSize: 'clamp(2.25rem, 4vw, 3rem)',
              fontWeight: 500,
              fontStyle: 'italic',
              color: '#0F1F18',
              lineHeight: 1.1,
              letterSpacing: '-0.025em',
            }}
          >
            {article.title}
          </h1>

          {article.summary && (
            <p className="font-serif text-xl text-content-secondary italic leading-relaxed mt-4 mb-2">
              {article.summary}
            </p>
          )}

          {/* Accent rule */}
          <div className="rule-accent mb-10 mt-6" />

          {/* Article body */}
          <article>
            <div ref={articleBodyRef} className="prose prose-lg prose-dropcap max-w-none" dangerouslySetInnerHTML={{ __html: freeHtml }} />

            {article.isPaywalled && !isUnlocked && (
              <PaywallGate pricePounds={pricePounds} freeAllowanceRemaining={user?.freeAllowanceRemainingPence ?? 0} hasPaymentMethod={user?.hasPaymentMethod ?? false} isLoggedIn={!!user} onUnlock={handleUnlock} unlocking={unlocking} error={unlockError} />
            )}

            {paywallBody && <div className="prose prose-lg max-w-none mt-10" dangerouslySetInnerHTML={{ __html: paywallHtml }} />}

            <div className="ornament mt-16 mb-12" />
            <ReplySection targetEventId={article.id} targetKind={30023} targetAuthorPubkey={article.pubkey} contentAuthorId={undefined} />
          </article>
        </div>
      </div>
    </div>
  )
}
