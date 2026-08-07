import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ProfileLink } from '../../../../components/ui/ProfileLink'
import { PublicationMasthead } from '../../../../components/publication/PublicationMasthead'
import { PublicPage } from '../../../../components/public/PublicPage'
import WorkspacePaneRedirect from '../../../../components/layout/WorkspacePaneRedirect'

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
  if (!res.ok) return { members: [] }
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
    openGraph: { title, description, type: 'website', siteName: 'all.haus' },
    twitter: { card: 'summary', title, description },
  }
}

export default async function MastheadPage({ params }: { params: { slug: string } }) {
  const [pub, data] = await Promise.all([
    getPublication(params.slug),
    getMasthead(params.slug),
  ])
  if (!pub) return notFound()

  const members = data.members ?? []

  return (
    <PublicPage>
      <WorkspacePaneRedirect overlay="surface" params={{ surface: `/pub/${params.slug}/masthead` }} />
      <PublicationMasthead pub={pub} view="masthead" />
      <div className="mx-auto max-w-feed px-4 sm:px-6 pt-14 pb-20">
        {members.length === 0 ? (
          <p className="label-ui text-grey-600 py-16 text-center">NO MASTHEAD YET</p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-9">
            {members.map((m: any) => (
              <li key={m.username} className="flex items-start gap-4">
                {m.avatar_blossom_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={m.avatar_blossom_url}
                    alt=""
                    className="w-14 h-14 rounded-full object-cover shrink-0"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-full bg-grey-200 shrink-0" />
                )}
                <div className="min-w-0">
                  <ProfileLink
                    href={`/@${m.username}`}
                    className="font-sans font-medium text-black hover:opacity-70"
                  >
                    {m.display_name || m.username}
                  </ProfileLink>
                  <p className="label-ui text-grey-600 mt-1">
                    {m.title || m.role}
                    {m.contributor_type && m.contributor_type !== 'staff'
                      ? ` · ${m.contributor_type}`
                      : ''}
                  </p>
                  {m.bio && (
                    <p className="font-sans text-ui-sm text-grey-600 mt-2 leading-[1.55]">
                      {m.bio}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PublicPage>
  )
}
