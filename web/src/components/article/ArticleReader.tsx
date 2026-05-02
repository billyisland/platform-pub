'use client'

import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../stores/auth'
import { PaywallGate } from './PaywallGate'
import { GiftLinkModal } from './GiftLinkModal'
import { QuoteSelector } from './QuoteSelector'
import { unwrapContentKey, decryptVaultContent } from '../../lib/vault'
import { renderMarkdown } from '../../lib/markdown'
import { Avatar } from '../ui/Avatar'
import { ReportButton } from '../ui/ReportButton'
import { ShareButton } from '../ui/ShareButton'
import { ReplySection } from '../replies/ReplySection'
import { AllowanceExhaustedModal } from '../ui/AllowanceExhaustedModal'
import { ForAllMark } from '../icons/ForAllMark'
import { articles as articlesApi, giftLinks } from '../../lib/api'
import { useReadingPosition } from '../../hooks/useReadingPosition'
import type { ArticleEvent } from '../../lib/ndk'

interface ArticleReaderProps {
  article: ArticleEvent
  articleDbId?: string
  writerName: string
  writerUsername: string
  writerAvatar?: string
  writerId?: string
  subscriptionPricePence?: number
  writerSpendThisMonthPence?: number
  nudgeShownThisMonth?: boolean
  preRenderedFreeHtml?: string
  publicationName?: string
  publicationSlug?: string
  // Slice 23b: explicit cover image (NIP-23 image tag). When set, wins over
  // the legacy first-inline-image scrape and the body markdown is rendered
  // unchanged (no stripHeroImage call). Pre-23b articles fall through to
  // the scrape path below.
  coverImageUrl?: string | null
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

export function ArticleReader({ article, articleDbId, writerName, writerUsername, writerAvatar, writerId, subscriptionPricePence, writerSpendThisMonthPence, nudgeShownThisMonth, preRenderedFreeHtml, publicationName, publicationSlug, coverImageUrl }: ArticleReaderProps) {
  const { user } = useAuth()
  const [paywallBody, setPaywallBody] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [showAllowanceModal, setShowAllowanceModal] = useState(false)
  const [freeHtml, setFreeHtml] = useState<string>(preRenderedFreeHtml ?? '')
  const [paywallHtml, setPaywallHtml] = useState<string>('')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  const [showGiftLinkModal, setShowGiftLinkModal] = useState(false)

  const isOwnContent = user?.id === writerId
  const articleBodyRef = useRef<HTMLDivElement>(null)

  useReadingPosition({ nostrEventId: article.id, enabled: !!user })

  // Explicit cover wins over the legacy scrape; when one is set the body
  // markdown is left intact (no stripHeroImage), so the same author can put
  // an image at the top of their body without it being silently swallowed.
  const heroImage = coverImageUrl ?? extractHeroImage(article.content)
  const contentWithoutHero =
    coverImageUrl
      ? article.content
      : heroImage
        ? stripHeroImage(article.content, heroImage)
        : article.content

  useEffect(() => { if (!preRenderedFreeHtml) renderMarkdown(contentWithoutHero).then(setFreeHtml) }, [contentWithoutHero, preRenderedFreeHtml])
  useEffect(() => { if (paywallBody) renderMarkdown(paywallBody).then(setPaywallHtml) }, [paywallBody])
  useEffect(() => {
    if (!article.isPaywalled) return
    const cached = sessionStorage.getItem(`unlocked:${article.id}`)
    if (cached) setPaywallBody(cached)
  }, [article.id, article.isPaywalled])

  // Redeem gift token from URL query param
  useEffect(() => {
    if (!articleDbId || !user) return
    const params = new URLSearchParams(window.location.search)
    const giftToken = params.get('gift')
    if (!giftToken) return
    giftLinks.redeem(articleDbId, giftToken)
      .then(() => { window.location.replace(window.location.pathname) })
      .catch(err => console.error('Failed to redeem gift link', err))
  }, [articleDbId, user])

  // Check subscription status for paywall gate
  useEffect(() => {
    if (!user || !writerId || !article.isPaywalled) return
    fetch(`/api/v1/subscriptions/check/${writerId}`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => { if (data.subscribed) setIsSubscribed(true) })
      .catch(err => console.error('Failed to check subscription status', err))
  }, [user, writerId, article.isPaywalled])

  async function handleSubscribe() {
    if (!user || !writerId) return
    setSubscribing(true)
    try {
      await fetch(`/api/v1/subscriptions/${writerId}`, { method: 'POST', credentials: 'include' })
      setIsSubscribed(true)
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
      console.error('Paywall unlock failed:', err)
      if (!unlockError) {
        const msg = err?.body?.message ?? err?.body?.error ?? err?.message
        setUnlockError(msg && msg !== '[object Object]' ? msg : 'Something went wrong. Please try again.')
      }
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

      <QuoteSelector
        articleBodyRef={articleBodyRef}
        articleId={article.id}
        articleTitle={article.title}
        articlePubkey={article.pubkey}
        writerName={writerName}
        isLoggedIn={!!user}
      />

      {showGiftLinkModal && articleDbId && (
        <GiftLinkModal articleDbId={articleDbId} onClose={() => setShowGiftLinkModal(false)} />
      )}

      {/* Article content */}
      <div className="mx-auto max-w-article-frame px-4 sm:px-6">
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
                  <span className="font-sans text-[14px]">
                    <a href={`/${writerUsername}`} className="font-semibold text-black hover:opacity-70 transition-opacity">{writerName}</a>
                    {publicationSlug && publicationName && (
                      <> in <a href={`/pub/${publicationSlug}`} className="font-semibold text-black hover:opacity-70 transition-opacity">{publicationName}</a></>
                    )}
                  </span>
                  <p className="font-sans text-[13px] text-grey-600">{publishDate}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <ShareButton
                  url={articleUrl}
                  title={article.title}
                  onGiftLink={isOwnContent && article.isPaywalled ? () => setShowGiftLinkModal(true) : undefined}
                />
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

            {/* Slab rule */}
            <div className="slab-rule-4 mb-10 mt-6" />

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
                  writerSpendThisMonthPence={writerSpendThisMonthPence}
                  nudgeShownThisMonth={nudgeShownThisMonth}
                  writerId={writerId}
                />
              )}

              {paywallBody && <div className="prose prose-lg mt-10" dangerouslySetInnerHTML={{ __html: paywallHtml }} />}

              <div className="flex justify-center mt-16 mb-12">
                <ForAllMark size={24} className="text-grey-300" />
              </div>
              <ReplySection targetEventId={article.id} targetKind={30023} targetAuthorPubkey={article.pubkey} contentAuthorId={undefined} isUnlocked={isUnlocked} />
            </article>

          </div>
        </div>
      </div>
    </div>
  )
}
