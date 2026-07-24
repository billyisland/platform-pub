import type { Metadata } from 'next'
import Link from 'next/link'
import HomeRedirect from '../components/layout/HomeRedirect'
import { ForAllMark } from '../components/icons/ForAllMark'

const TITLE = 'all.haus — Read everything in one place.'
const DESCRIPTION =
  'Articles, notes, and feeds from across the web — one reader. Pay only for what\'s worth it.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: 'website',
    siteName: 'all.haus',
  },
  twitter: {
    card: 'summary',
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function HomePage() {
  return (
    // Readers-first, in the logged-out register's own idiom (matches
    // /auth, /waitlist, /about): centred ∀, serif head, mono copy, .btn.
    // CLOSED-BETA-ADR §IV. About / Log in live in the topbar — not repeated.
    <div className="mx-auto max-w-sm px-4 sm:px-6 py-28 text-center">
      <HomeRedirect />

      <div className="flex justify-center mb-8">
        <ForAllMark size={36} className="text-crimson" />
      </div>

      <h1
        className="font-serif font-medium text-black tracking-tight"
        style={{ fontSize: '30px' }}
      >
        Read everything in one place.
      </h1>
      <p className="mt-4 text-mono-sm text-grey-600 leading-relaxed">
        Articles, notes, and feeds from across the web — one reader.
        Pay only for what&apos;s worth it.
      </p>

      <div className="mt-10">
        <Link href="/waitlist" className="btn-accent inline-block">
          Join the waiting list
        </Link>
      </div>

      <p className="mt-10 text-mono-xs text-grey-400">
        all.haus is in closed beta — invited users for now.
      </p>
    </div>
  )
}
