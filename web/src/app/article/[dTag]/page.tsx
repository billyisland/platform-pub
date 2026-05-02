import { notFound } from 'next/navigation'
import Script from 'next/script'
import type { Metadata } from 'next'
import { renderMarkdown } from '../../../lib/markdown'
import { ArticleReader } from '../../../components/article/ArticleReader'
import { TraffologyMeta } from '../../../components/traffology/TraffologyMeta'
import type { ArticleMetadata } from '../../../lib/api'

// =============================================================================
// Article Page — /article/:dTag  (Server Component)
//
// Fetches article metadata + free content from the gateway at request time,
// renders markdown to HTML on the server, and passes the result to the
// ArticleReader client component for interactive features (paywall, replies,
// quote selection).
//
// The article body arrives as static HTML — no JavaScript needed to read it.
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

async function getArticle(dTag: string): Promise<ArticleMetadata | null> {
  const res = await fetch(`${GATEWAY}/api/v1/articles/${dTag}`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

function extractFirstImage(markdown: string | null): string | undefined {
  if (!markdown) return undefined
  const match = markdown.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/)
  return match?.[1] ?? undefined
}

export async function generateMetadata({ params }: { params: { dTag: string } }): Promise<Metadata> {
  const article = await getArticle(params.dTag)
  if (!article) return {}

  const title = article.title
  const description = article.summary || `By ${article.writer.displayName ?? article.writer.username}`
  const authorName = article.writer.displayName ?? article.writer.username
  const url = `https://all.haus/article/${article.dTag}`
  // Prefer the explicit cover (slice 23b); fall back to inline-image scrape
  // for legacy articles that have no cover_image_url set.
  const image = article.coverImageUrl ?? extractFirstImage(article.contentFree)

  return {
    title,
    description,
    authors: [{ name: authorName }],
    openGraph: {
      title,
      description,
      type: 'article',
      url,
      siteName: article.publication?.name ?? 'all.haus',
      publishedTime: article.publishedAt ?? undefined,
      authors: [authorName],
      ...(image && { images: [{ url: image }] }),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description,
    },
  }
}

export default async function ArticlePage({ params }: { params: { dTag: string } }) {
  const article = await getArticle(params.dTag)
  if (!article) return notFound()

  // Render free-section markdown to HTML on the server
  const freeHtml = article.contentFree
    ? await renderMarkdown(article.contentFree)
    : ''

  return (
    <>
    <TraffologyMeta articleId={article.id} />
    <ArticleReader
      article={{
        id: article.nostrEventId,
        pubkey: article.writer.pubkey,
        dTag: article.dTag,
        title: article.title,
        summary: article.summary ?? '',
        content: article.contentFree ?? '',
        publishedAt: article.publishedAt
          ? Math.floor(new Date(article.publishedAt).getTime() / 1000)
          : 0,
        tags: [],
        pricePence: article.pricePence ?? undefined,
        gatePositionPct: article.gatePositionPct ?? undefined,
        isPaywalled: article.isPaywalled,
      }}
      coverImageUrl={article.coverImageUrl ?? null}
      articleDbId={article.id}
      writerName={article.writer.displayName ?? article.writer.username}
      writerUsername={article.writer.username}
      writerAvatar={article.writer.avatar ?? undefined}
      writerId={article.writer.id}
      subscriptionPricePence={article.publication?.subscriptionPricePence ?? article.writer.subscriptionPricePence}
      writerSpendThisMonthPence={article.writerSpendThisMonthPence ?? undefined}
      nudgeShownThisMonth={article.nudgeShownThisMonth ?? false}
      preRenderedFreeHtml={freeHtml}
      publicationName={article.publication?.name ?? undefined}
      publicationSlug={article.publication?.slug ?? undefined}
    />
    <Script src="/traffology.js" strategy="afterInteractive" />
    </>
  )
}
