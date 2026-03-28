import Link from 'next/link'

export default function HomePage() {
  return (
    <div className="mx-auto max-w-article-frame px-6 py-24">
      <section>
        <h1 className="font-serif text-6xl font-medium leading-[1.05] text-ink sm:text-7xl" style={{ letterSpacing: '-0.03em' }}>
          Free authors.
        </h1>
        <p className="font-serif text-6xl font-normal leading-[1.05] text-content-muted sm:text-7xl mt-1" style={{ letterSpacing: '-0.03em' }}>
          Writing that's worth something.
        </p>

        <div className="rule-accent mt-12" />

        <p className="mt-8 text-lg text-content-primary leading-relaxed max-w-lg">
          At Platform, you own your identity. Build a profile that
          exists on your terms. Find an audience that pays, from
          day one.
        </p>

        <div className="mt-10">
          <Link href="/auth?mode=signup" className="btn text-base px-10 py-4">
            Get started — free £5 credit
          </Link>
        </div>
      </section>

      <div className="mt-32 ornament" />
    </div>
  )
}
