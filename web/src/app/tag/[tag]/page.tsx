import type { Metadata } from 'next'
import { TagBrowser } from './TagBrowser'

export async function generateMetadata({ params }: { params: { tag: string } }): Promise<Metadata> {
  const tagName = params.tag.toLowerCase()
  const title = `#${tagName} — all.haus`
  const description = `Articles tagged #${tagName} on all.haus`

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

export default function TagPage({ params }: { params: { tag: string } }) {
  return <TagBrowser tagName={params.tag.toLowerCase()} />
}
