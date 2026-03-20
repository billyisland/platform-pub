'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { PaywallGate } from './PaywallGate'
import { unwrapContentKey, decryptVaultContent } from '../../lib/vault'
import { getNdk, fetchVaultEvent } from '../../lib/ndk'
import { renderMarkdown } from '../../lib/markdown'
import { ReportButton } from '../ui/ReportButton'
import { CommentSection } from '../comments/CommentSection'
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
  const [freeHtml, setFreeHtml] = useState<string>('')
  const [paywallHtml, setPaywallHtml] = useState<string>('')

  const heroImage = extractHeroImage(article.content)
  const contentWithoutHero = heroImage ? stripHeroImage(article.content, heroImage) : article.content

  useEffect(() => { renderMarkdown(contentWithoutHero).then(setFreeHtml) }, [contentWithoutHero])
  useEffect(() => { if (paywallBody) renderMarkdown(paywallBody).then(setPaywallHtml) }, [paywallBody])
  useEffect(() => {
    if (!article.isPaywalled) return
    const cached = sessionStorage.getItem(`unlocked:${article.id}`)
    if (cached) setPaywallBody(cached)
  }, [article.id, article.isPaywalled])

  async function handleUnlock() {
    if (!user) { window.location.href = '/auth?mode=signup'; return }
    setUnlocking(true); setUnlockError(null)
    try {
      const ndk = getNdk(); await ndk.connect()
      const vaultEvent = await fetchVaultEvent(ndk, article.dTag)
      if (!vaultEvent) { setUnlockError('Could not find the encrypted content.'); return }
      let gatePassResult
      try { gatePassResult = await articlesApi.gatePass(article.id) }
      catch (err: any) {
        if (err.status === 402) {
          setUnlockError(!user.hasPaymentMethod && user.freeAllowanceRemainingPence <= 0 ? 'Your free allowance has been used. Add a card.' : 'Payment required.')
          return
        }
        throw err
      }
      const contentKeyBase64 = await unwrapContentKey(gatePassResult.encryptedKey)
      const body = await decryptVaultContent(vaultEvent.ciphertext, contentKeyBase64)
      setPaywallBody(body)
      sessionStorage.setItem(`unlocked:${article.id}`, body)
    } catch (err: any) {
      if (!unlockError) setUnlockError('Something went wrong. Please try again.')
    } finally { setUnlocking(false) }
  }

  const isUnlocked = !article.isPaywalled || paywallBody !== null
  const pricePounds = article.pricePence ? (article.pricePence / 100).toFixed(2) : null
  const publishDate = new Date(article.publishedAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="min-h-screen bg-surface">
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
            <h1 className="font-serif text-3xl font-light leading-tight text-white sm:text-4xl tracking-tight">
              {article.title}
            </h1>
          </div>
        </div>
      ) : (
        /* Standard header — no hero image */
        <div className="mx-auto max-w-article px-6 pt-16">
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
            <ReportButton targetNostrEventId={article.id} />
          </div>
          <h1 className="font-serif text-3xl font-light leading-tight text-ink-900 sm:text-4xl mb-10 tracking-tight">{article.title}</h1>
          <div className="rule-accent mb-10" />
        </div>
      )}

      {/* Article body */}
      <article className="mx-auto max-w-article px-6 py-8">
        {heroImage && (
          <div className="flex items-center justify-between mb-8">
            <div />
            <ReportButton targetNostrEventId={article.id} />
          </div>
        )}

        <div className="prose prose-lg max-w-none" dangerouslySetInnerHTML={{ __html: freeHtml }} />

        {article.isPaywalled && !isUnlocked && (
          <PaywallGate pricePounds={pricePounds} freeAllowanceRemaining={user?.freeAllowanceRemainingPence ?? 0} hasPaymentMethod={user?.hasPaymentMethod ?? false} isLoggedIn={!!user} onUnlock={handleUnlock} unlocking={unlocking} error={unlockError} />
        )}

        {paywallBody && <div className="prose prose-lg max-w-none mt-10" dangerouslySetInnerHTML={{ __html: paywallHtml }} />}

        <div className="ornament mt-16 mb-12" />
        <CommentSection targetEventId={article.id} targetKind={30023} targetAuthorPubkey={article.pubkey} contentAuthorId={undefined} />
      </article>
    </div>
  )
}
