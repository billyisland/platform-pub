'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { useAuth } from '../../stores/auth'
import { PaywallGate } from './PaywallGate'
import { unwrapContentKey, decryptVaultContent } from '../../lib/vault'
import { renderMarkdown } from '../../lib/markdown'
import { Avatar } from '../ui/Avatar'
import { ReportButton } from '../ui/ReportButton'
import { ShareButton } from '../ui/ShareButton'
import { ReplySection } from '../replies/ReplySection'
import { AllowanceExhaustedModal } from '../ui/AllowanceExhaustedModal'
import { NoteComposer } from '../feed/NoteComposer'
import { ThereforeMark } from '../icons/ThereforeMark'
import { articles as articlesApi } from '../../lib/api'
import type { ArticleEvent } from '../../lib/ndk'

interface ArticleReaderProps {
  article: ArticleEvent
  writerName: string
  writerUsername: string
  writerAvatar?: string
  writerId?: string
  subscriptionPricePence?: number
  preRenderedFreeHtml?: string
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

export function ArticleReader({ article, writerName, writerUsername, writerAvatar, writerId, subscriptionPricePence, preRenderedFreeHtml }: ArticleReaderProps) {
  const { user } = useAuth()
  const [paywallBody, setPaywallBody] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [showAllowanceModal, setShowAllowanceModal] = useState(false)
  const [freeHtml, setFreeHtml] = useState<string>(preRenderedFreeHtml ?? '')
  const [paywallHtml, setPaywallHtml] = useState<string>('')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [subscribing, setSubscribing] = useState(false)

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

  useEffect(() => { if (!preRenderedFreeHtml) renderMarkdown(contentWithoutHero).then(setFreeHtml) }, [contentWithoutHero, preRenderedFreeHtml])
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

  // Check subscription status for paywall gate
  useEffect(() => {
    if (!user || !writerId || !article.isPaywalled) return
    fetch(`/api/v1/subscriptions/check/${writerId}`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => { if (data.subscribed) setIsSubscribed(true) })
      .catch(() => {})
  }, [user, writerId, article.isPaywalled])

  async function handleSubscribe() {
    if (!user || !writerId) return
    setSubscribing(true)
    try {
      await fetch(`/api/v1/subscriptions/${writerId}`, { method: 'POST', credentials: 'include' })
      setIsSubscribed(true)
      // After subscribing, unlock the article
      handleUnlock()
    } catch { setUnlockError('Failed to subscribe. Try again.') }
    finally { setSubscribing(false) }
  }

  async function handleUnlock() {
    if (!user) { window.location.href = '/auth?mode=signup'; return }
    setUnlocking(true); setUnlockError(null)
    try {
      let gatePassResult
      try { gatePassResult = await articlesApi.gatePass(article.id) }
      catch (err: any) {
        if (err.status === 402) {
          setUnlockError('Payment required.')
          return
        }
        throw err
      }

      const ciphertext: string | undefined = gatePassResult.ciphertext
        ?? article.encryptedPayload

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
    <div className="min-h-screen bg-white">
      {showAllowanceModal && <AllowanceExhaustedModal onClose={() => setShowAllowanceModal(false)} />}

      {/* Text-selection quote popup */}
      {selectionPopup && (
        <div
          className="fixed z-50 bg-black text-white px-3 py-1.5 text-[12px] font-sans shadow-lg"
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
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
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

      {/* Article content */}
      <div className="mx-auto max-w-article-frame px-6">
        <div className="px-5 py-6 sm:px-10 sm:py-8 md:px-[72px] md:py-10">
          {/* Hero image */}
          {heroImage && (
            <div className="-mx-5 -mt-6 sm:-mx-10 sm:-mt-8 md:-mx-[72px] md:-mt-10 mb-8">
              <img src={heroImage} alt="" className="w-full max-h-[400px] object-cover" />
            </div>
          )}

          {/* Content column — 640px centred */}
          <div className="max-w-article mx-auto">

            {/* Byline — Instrument Sans name + date */}
            <div className="mb-8 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Avatar src={writerAvatar} name={writerName} size={36} lazy={false} />
                <div>
                  <a href={`/${writerUsername}`} className="font-sans text-[14px] font-semibold text-black hover:opacity-70 transition-opacity">{writerName}</a>
                  <p className="font-sans text-[13px] text-grey-400">{publishDate}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <ShareButton url={articleUrl} title={article.title} />
                <ReportButton targetNostrEventId={article.id} />
              </div>
            </div>

            {/* Title — Literata roman (not italic in reader — writer's space) */}
            <h1
              className="mb-4 font-serif text-black leading-[1.1]"
              style={{
                fontSize: 'clamp(2.125rem, 4vw, 2.125rem)',
                fontWeight: 500,
                letterSpacing: '-0.025em',
              }}
            >
              {article.title}
            </h1>

            {article.summary && (
              <p className="font-serif text-xl text-grey-600 italic leading-relaxed mt-4 mb-2">
                {article.summary}
              </p>
            )}

            {/* Rule — grey-200 */}
            <div className="border-t border-grey-200 mb-10 mt-6" />

            {/* Article body */}
            <article>
              <div ref={articleBodyRef} className="prose prose-lg prose-dropcap" dangerouslySetInnerHTML={{ __html: freeHtml }} />

              {article.isPaywalled && !isUnlocked && (
                <PaywallGate
                  pricePounds={pricePounds}
                  freeAllowanceRemaining={user?.freeAllowanceRemainingPence ?? 0}
                  hasPaymentMethod={user?.hasPaymentMethod ?? false}
                  isLoggedIn={!!user}
                  onUnlock={handleUnlock}
                  unlocking={unlocking}
                  error={unlockError}
                  writerUsername={writerUsername}
                  writerName={writerName}
                  subscriptionPricePence={subscriptionPricePence}
                  isSubscribed={isSubscribed}
                  onSubscribe={handleSubscribe}
                  subscribing={subscribing}
                />
              )}

              {paywallBody && <div className="prose prose-lg mt-10" dangerouslySetInnerHTML={{ __html: paywallHtml }} />}

              <div className="ornament mt-16 mb-12">
                <ThereforeMark size={24} weight="light" className="text-grey-400" />
              </div>
              <ReplySection targetEventId={article.id} targetKind={30023} targetAuthorPubkey={article.pubkey} contentAuthorId={undefined} />
            </article>

          </div>
        </div>
      </div>
    </div>
  )
}
