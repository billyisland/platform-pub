import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { WriterActivity } from '../../components/profile/WriterActivity'
import { Avatar } from '../../components/ui/Avatar'
import type { WriterProfile } from '../../lib/api'

// =============================================================================
// Writer Profile Page — /[username]  (Server Component)
//
// Fetches the writer's profile from the gateway at request time and renders
// the static header (name, avatar, bio) as HTML. The interactive activity
// feed (articles, notes, replies, votes, follow/subscribe) is a client
// component island that hydrates on top.
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'
const SITE_URL = process.env.APP_URL ?? 'https://all.haus'

async function getWriter(username: string): Promise<WriterProfile | null> {
  const res = await fetch(`${GATEWAY}/api/v1/writers/${username}`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

export async function generateMetadata({ params }: { params: { username: string } }): Promise<Metadata> {
  const writer = await getWriter(params.username)
  if (!writer) return {}

  const title = `${writer.displayName ?? params.username} — all.haus`
  const description = writer.bio || `Articles by ${writer.displayName ?? params.username} on all.haus`
  const url = `${SITE_URL}/${params.username}`

  return {
    title,
    description,
    alternates: {
      types: {
        'application/rss+xml': `${SITE_URL}/rss/${params.username}`,
      },
    },
    openGraph: {
      title,
      description,
      type: 'profile',
      url,
      siteName: 'all.haus',
      ...(writer.avatar && { images: [{ url: writer.avatar }] }),
    },
    twitter: {
      card: 'summary',
      title,
      description,
    },
  }
}

export default async function WriterProfilePage({ params }: { params: { username: string } }) {
  const writer = await getWriter(params.username)
  if (!writer) return notFound()

  return (
    <div className="mx-auto max-w-article-frame px-4 sm:px-6 py-12">
      {/* Static profile header — arrives as HTML */}
      <div className="mb-12">
        <div className="flex items-center gap-4 mb-4">
          <Avatar src={writer.avatar} name={writer.displayName ?? params.username} size={56} lazy={false} />
          <div className="flex-1">
            <h1
              className="font-serif text-3xl sm:text-4xl font-light text-black"
              style={{ letterSpacing: '-0.02em' }}
            >
              {writer.displayName ?? params.username}
            </h1>
            <p className="text-ui-xs text-grey-300 mt-0.5">@{params.username}</p>
          </div>
        </div>

        {writer.bio && (
          <p
            className="font-serif text-sm text-grey-600 leading-relaxed max-w-lg"
            style={{ lineHeight: '1.7' }}
          >
            {writer.bio}
          </p>
        )}
        <p className="mt-4 text-ui-xs text-grey-300">
          {writer.articleCount} article{writer.articleCount !== 1 ? 's' : ''}
          {' · '}
          {writer.followerCount} follower{writer.followerCount !== 1 ? 's' : ''}
          {' · '}
          {writer.followingCount} following
          {' · '}
          <a
            href={`/rss/${params.username}`}
            className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-300 hover:text-black"
          >
            RSS
          </a>
        </p>
      </div>

      <div className="rule-inset mb-10" />

      {/* Interactive activity feed — client component island */}
      <WriterActivity
        username={params.username}
        writer={writer}
      />
    </div>
  )
}
