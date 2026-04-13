import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import Link from 'next/link'

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

async function getPublication(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/public`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

async function getMasthead(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/publications/${slug}/masthead`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const pub = await getPublication(params.slug)
  if (!pub) return {}

  const title = `Masthead — ${pub.name} — all.haus`
  const description = `The team behind ${pub.name}`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: 'all.haus',
    },
    twitter: {
      card: 'summary',
      title,
      description,
    },
  }
}

export default async function MastheadPage({ params }: { params: { slug: string } }) {
  const data = await getMasthead(params.slug)
  if (!data) return notFound()

  return (
    <div className="max-w-article mx-auto">
      <h1 className="font-serif text-3xl mb-8">Masthead</h1>
      <div className="space-y-6">
        {data.members.map((m: any) => (
          <div key={m.account_id} className="flex items-start gap-4">
            {m.avatar_blossom_url ? (
              <img src={m.avatar_blossom_url} alt="" className="w-12 h-12 rounded-full object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-full bg-grey-200" />
            )}
            <div>
              <Link href={`/@${m.username}`} className="font-medium text-black hover:opacity-70">
                {m.display_name || m.username}
              </Link>
              <p className="text-ui-xs text-grey-400">
                {m.title || m.role}
                {m.contributor_type !== 'staff' && ` \u00b7 ${m.contributor_type}`}
              </p>
              {m.bio && <p className="text-sm text-grey-600 mt-1">{m.bio}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
