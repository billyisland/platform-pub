import { notFound } from 'next/navigation'
import { HomepageBlog } from '../../../components/publication/HomepageBlog'
import { HomepageMagazine } from '../../../components/publication/HomepageMagazine'
import { HomepageMinimal } from '../../../components/publication/HomepageMinimal'

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

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

export default async function PublicationHomepage({ params }: { params: { slug: string } }) {
  const [pub, data] = await Promise.all([
    getPublication(params.slug),
    getArticles(params.slug),
  ])
  if (!pub) return notFound()

  const layout = pub.homepage_layout ?? 'blog'

  return (
    <div>
      {/* Header */}
      {pub.tagline && (
        <p className="text-grey-500 text-sm mb-8 text-center">{pub.tagline}</p>
      )}

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
