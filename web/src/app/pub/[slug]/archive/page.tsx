import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { PublicationMasthead } from '../../../../components/publication/PublicationMasthead'
import { PublicPage } from '../../../../components/public/PublicPage'
import {
  ArticleLink,
  EmptyState,
  PubByline,
  articleKey,
  formatPubDate,
  type PubArticle,
} from '../../../../components/publication/article-shared'
import WorkspacePaneRedirect from '../../../../components/layout/WorkspacePaneRedirect'

// =============================================================================
// Publication archive — /pub/:slug/archive
//
// The complete index, grouped by year. Entries are separated by rhythm, not by
// the bottom rule this page used to draw on every row — one of five
// single-pixel lines the tripwire caught across this surface.
//
// The year headings are what make a long archive navigable, and they are mono
// infrastructure voice rather than serif — they label the list, they are not
// part of the writing.
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

async function getPublication(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/public`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

async function getArticles(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/by-slug/${slug}/articles?limit=100`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return { articles: [] }
  return res.json()
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const pub = await getPublication(params.slug)
  if (!pub) return {}
  return {
    title: `Archive — ${pub.name} — all.haus`,
    description: `Every article published by ${pub.name}`,
  }
}

/** Group in the order the API returned (published_at DESC), so years stay descending. */
function groupByYear(articles: PubArticle[]): [string, PubArticle[]][] {
  const groups = new Map<string, PubArticle[]>()
  for (const a of articles) {
    const year = a.published_at
      ? String(new Date(a.published_at).getFullYear())
      : 'Undated'
    const bucket = groups.get(year)
    if (bucket) bucket.push(a)
    else groups.set(year, [a])
  }
  return [...groups.entries()]
}

export default async function ArchivePage({ params }: { params: { slug: string } }) {
  const [pub, data] = await Promise.all([
    getPublication(params.slug),
    getArticles(params.slug),
  ])
  if (!pub) return notFound()

  const articles: PubArticle[] = data.articles ?? []
  const years = groupByYear(articles)

  return (
    <PublicPage>
      <WorkspacePaneRedirect overlay="surface" params={{ surface: `/pub/${params.slug}/archive` }} />
      <PublicationMasthead pub={pub} view="archive" />
      <div className="mx-auto max-w-feed px-4 sm:px-6 pt-14 pb-20">
        {articles.length === 0 ? (
          <EmptyState />
        ) : (
          years.map(([year, group], gi) => (
            <section key={year} className={gi === 0 ? '' : 'mt-14'}>
              <h2 className="label-ui text-grey-600 mb-5">{year}</h2>
              <ul>
                {group.map((a, i) => (
                  <li key={articleKey(a)} className={i === 0 ? '' : 'mt-6'}>
                    <ArticleLink slug={params.slug} article={a}>
                      <div className="flex items-baseline justify-between gap-6">
                        <h3 className="font-serif text-black text-[1.0625rem] leading-[1.35] group-hover:text-crimson-dark transition-colors">
                          {a.title}
                        </h3>
                        {a.published_at && (
                          <span className="font-mono text-mono-xs text-grey-600 shrink-0">
                            {formatPubDate(a.published_at)}
                          </span>
                        )}
                      </div>
                      <PubByline article={a} className="mt-1" showDate={false} />
                    </ArticleLink>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </PublicPage>
  )
}
