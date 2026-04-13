import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { HomepageBlog } from '../../../components/publication/HomepageBlog'
import { HomepageMagazine } from '../../../components/publication/HomepageMagazine'
import { HomepageMinimal } from '../../../components/publication/HomepageMinimal'
import { PubFollowButton } from '../../../components/publication/PubFollowButton'

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'
const SITE_URL = process.env.APP_URL ?? 'https://all.haus'

async function getPublication(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/public`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

async function getArticles(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/by-slug/${slug}/articles?limit=20`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return { articles: [] }
  return res.json()
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const pub = await getPublication(params.slug)
  if (!pub) return {}

  const title = `${pub.name} — all.haus`
  const description = pub.tagline || `${pub.name} on all.haus`
  const url = `${SITE_URL}/pub/${params.slug}`
  const image = pub.logo_blossom_url ?? pub.cover_blossom_url

  return {
    title,
    description,
    alternates: {
      types: {
        'application/rss+xml': `${SITE_URL}/api/v1/pub/${params.slug}/rss`,
      },
    },
    openGraph: {
      title,
      description,
      type: 'website',
      url,
      siteName: 'all.haus',
      ...(image && { images: [{ url: image }] }),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description,
    },
  }
}

export default async function PublicationHomepage({ params }: { params: { slug: string } }) {
  const [pub, data] = await Promise.all([
    getPublication(params.slug),
    getArticles(params.slug),
  ])
  if (!pub) return notFound()

  const layout = pub.homepage_layout ?? 'blog'

  return (
    <div>
      {/* Masthead */}
      <div className="text-center mb-10">
        <h1 className="font-serif text-2xl font-light tracking-tight text-black">
          {pub.name}
        </h1>
        {pub.tagline && (
          <p className="text-grey-500 text-sm mt-2">{pub.tagline}</p>
        )}
        <div className="mt-4 flex items-center justify-center gap-4">
          <PubFollowButton publicationId={pub.id} initialFollowing={pub.isFollowing ?? false} />
          <a
            href={`/api/v1/pub/${pub.slug}/rss`}
            className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-300 hover:text-black"
          >
            RSS
          </a>
        </div>
      </div>

      {/* Articles in chosen layout */}
      {layout === 'magazine' && (
        <HomepageMagazine slug={pub.slug} articles={data.articles} />
      )}
      {layout === 'minimal' && (
        <HomepageMinimal slug={pub.slug} articles={data.articles} />
      )}
      {layout === 'blog' && (
        <HomepageBlog slug={pub.slug} articles={data.articles} />
      )}
    </div>
  )
}
