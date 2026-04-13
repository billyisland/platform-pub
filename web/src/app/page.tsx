import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'all.haus — Free authors. Writing that\'s worth something.',
  description: 'Own your identity. Build a profile that exists on your terms. Find an audience that pays, from day one.',
  openGraph: {
    title: 'all.haus — Free authors. Writing that\'s worth something.',
    description: 'Own your identity. Build a profile that exists on your terms. Find an audience that pays, from day one.',
    type: 'website',
    siteName: 'all.haus',
  },
  twitter: {
    card: 'summary',
    title: 'all.haus — Free authors. Writing that\'s worth something.',
    description: 'Own your identity. Build a profile that exists on your terms. Find an audience that pays, from day one.',
  },
}

export default function HomePage() {
  return (
    <div className="mx-auto max-w-article-frame px-4 sm:px-6 py-24">

      {/* ── Section 1: Hero ── */}
      <section>
        <h1 className="hero-headline font-sans font-semibold text-black">
          Free authors.
        </h1>
        <p className="hero-headline font-sans font-semibold text-grey-600 mt-1">
          Writing that&apos;s worth something.
        </p>

        {/* 6px slab rule */}
        <div className="slab-rule mt-12" />

        <p className="mt-8 font-sans text-[18px] text-black leading-relaxed max-w-[440px]">
          At all.haus, you own your identity. Build a profile that
          exists on your terms. Find an audience that pays, from
          day one.
        </p>

        <div className="mt-10 flex flex-col gap-3 items-start">
          <Link href="/about" className="btn inline-block">
            About all.haus
          </Link>
          <Link href="/auth?mode=signup" className="btn-accent inline-block">
            Get started — free £5 credit
          </Link>
        </div>
      </section>
    </div>
  )
}
