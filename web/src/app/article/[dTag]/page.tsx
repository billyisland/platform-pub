'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { articles as articlesApi, type ArticleMetadata } from '../../../lib/api'
import { getNdk, fetchArticleByDTag, type ArticleEvent } from '../../../lib/ndk'
import { ArticleReader } from '../../../components/article/ArticleReader'

// =============================================================================
// Article Page — /article/:dTag
//
// Fetches article metadata from the gateway (DB index) and the full NIP-23
// content from the relay. Renders via ArticleReader which handles the
// paywall gate and vault decryption.
//
// Two data sources:
//   - Gateway /articles/:dTag → metadata, writer info, paywall config
//   - Relay NIP-23 event → actual article markdown content
//
// The gateway metadata includes writer display name, avatar, and paywall
// info. The relay has the canonical content. Both are needed.
// =============================================================================

export default function ArticlePage() {
  const params = useParams()
  const dTag = params.dTag as string

  const [metadata, setMetadata] = useState<ArticleMetadata | null>(null)
  const [article, setArticle] = useState<ArticleEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    async function loadArticle() {
      setLoading(true)
      try {
        // Step 1: Fetch metadata from gateway
        const meta = await articlesApi.getByDTag(dTag)
        setMetadata(meta)

        // Step 2: Fetch the NIP-23 event from the relay
        const ndk = getNdk()
        await ndk.connect()
        const articleEvent = await fetchArticleByDTag(ndk, meta.writer.pubkey, dTag)

        if (!articleEvent) {
          // Metadata exists but relay event not found — fallback to metadata
          // This can happen if the relay hasn't received the event yet
          setArticle({
            id: meta.nostrEventId,
            pubkey: meta.writer.pubkey,
            dTag: meta.dTag,
            title: meta.title,
            summary: meta.summary ?? '',
            content: '', // No content available from relay
            publishedAt: meta.publishedAt
              ? Math.floor(new Date(meta.publishedAt).getTime() / 1000)
              : 0,
            tags: [],
            pricePence: meta.pricePence ?? undefined,
            gatePositionPct: meta.gatePositionPct ?? undefined,
            isPaywalled: meta.isPaywalled,
          })
        } else {
          // Merge: relay has content, gateway has paywall config.
          // Always use meta.nostrEventId as the canonical id — the relay may
          // have a newer event (different id) that hasn't been re-indexed yet.
          setArticle({
            ...articleEvent,
            id: meta.nostrEventId,
            pricePence: meta.pricePence ?? articleEvent.pricePence,
            gatePositionPct: meta.gatePositionPct ?? articleEvent.gatePositionPct,
            isPaywalled: meta.isPaywalled,
          })
        }
      } catch (err: any) {
        if (err.status === 404) {
          setNotFound(true)
        } else {
          console.error('Article load error:', err)
        }
      } finally {
        setLoading(false)
      }
    }

    if (dTag) loadArticle()
  }, [dTag])

  if (loading) {
    return <ArticleSkeleton />
  }

  if (notFound || !article || !metadata) {
    return (
      <div className="mx-auto max-w-article px-6 py-24 text-center">
        <h1 className="font-serif text-2xl font-bold text-ink mb-2">
          Article not found
        </h1>
        <p className="text-content-muted">
          This article doesn't exist or has been removed.
        </p>
      </div>
    )
  }

  return (
    <ArticleReader
      article={article}
      writerName={metadata.writer.displayName ?? metadata.writer.username}
      writerUsername={metadata.writer.username}
      writerAvatar={metadata.writer.avatar ?? undefined}
    />
  )
}

function ArticleSkeleton() {
  return (
    <div className="mx-auto max-w-article px-6 py-12">
      {/* Byline */}
      <div className="flex items-center gap-3 mb-8">
        <div className="h-10 w-10 animate-pulse rounded-full bg-surface-deep" />
        <div>
          <div className="h-4 w-28 animate-pulse rounded bg-surface-deep mb-1" />
          <div className="h-3 w-20 animate-pulse rounded bg-surface-deep" />
        </div>
      </div>
      {/* Title */}
      <div className="h-10 w-3/4 animate-pulse rounded bg-surface-deep mb-4" />
      <div className="h-10 w-1/2 animate-pulse rounded bg-surface-deep mb-10" />
      {/* Body */}
      <div className="space-y-3">
        <div className="h-4 w-full animate-pulse rounded bg-surface-deep" />
        <div className="h-4 w-full animate-pulse rounded bg-surface-deep" />
        <div className="h-4 w-5/6 animate-pulse rounded bg-surface-deep" />
        <div className="h-4 w-full animate-pulse rounded bg-surface-deep" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-surface-deep" />
      </div>
    </div>
  )
}
