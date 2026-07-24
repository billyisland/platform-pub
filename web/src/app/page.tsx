import type { Metadata } from 'next'
import Link from 'next/link'
import HomeRedirect from '../components/layout/HomeRedirect'

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
    <div className="mx-auto max-w-article-frame px-4 sm:px-6 py-24">
      <HomeRedirect />

      {/* ── Section 1: Hero (readers-first — CLOSED-BETA-ADR §IV) ── */}
      <section>
        <h1 className="hero-headline font-sans font-semibold text-black">
          Read everything
        </h1>
        <p className="hero-headline font-sans font-semibold text-grey-600 mt-1">
          in one place.
        </p>

        {/* 6px slab rule */}
        <div className="slab-rule mt-12" />

        <p className="mt-8 font-sans text-[18px] text-black leading-relaxed max-w-[440px]">
          Articles, notes, and feeds from across the web — one reader.
          Pay only for what&apos;s worth it.
        </p>

        <div className="mt-10 flex flex-col gap-3 items-start">
          <Link href="/waitlist" className="btn-accent inline-block">
            Join the waiting list
          </Link>
          <Link href="/auth?mode=login" className="btn inline-block">
            Log in
          </Link>
        </div>

        <div className="mt-6">
          <Link href="/about" className="btn-text-muted">
            About all.haus
          </Link>
        </div>

        <p className="mt-10 text-mono-xs text-grey-400">
          all.haus is in closed beta — invited users for now.
        </p>
      </section>
    </div>
  )
}
