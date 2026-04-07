import { notFound } from 'next/navigation'
import Link from 'next/link'

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

async function getArticles(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/by-slug/${slug}/articles?limit=100`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

export default async function ArchivePage({ params }: { params: { slug: string } }) {
  const data = await getArticles(params.slug)
  if (!data) return notFound()

  return (
    <div className="max-w-article mx-auto">
      <h1 className="font-serif text-3xl mb-8">Archive</h1>
      {data.articles.length === 0 ? (
        <p className="text-grey-400 text-sm">No articles published yet.</p>
      ) : (
        <div className="space-y-0">
          {data.articles.map((a: any) => (
            <article key={a.nostr_d_tag} className="border-b border-grey-200 py-4">
              <Link href={`/pub/${params.slug}/${a.nostr_d_tag}`} className="block group">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 className="font-serif text-base text-black group-hover:opacity-70">{a.title}</h2>
                  {a.published_at && (
                    <span className="text-ui-xs text-grey-300 shrink-0">
                      {new Date(a.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  )}
                </div>
                <p className="text-ui-xs text-grey-400 mt-0.5">
                  {a.author_display_name || a.author_username}
                </p>
              </Link>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
