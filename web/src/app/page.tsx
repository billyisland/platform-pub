import Link from 'next/link'

export default function HomePage() {
  return (
    <div className="mx-auto max-w-article px-6 py-24">
      <section>
        <h1 className="font-serif text-5xl font-light leading-tight text-ink-900 sm:text-6xl tracking-tight">
          Free authors.
        </h1>
        <p className="font-serif text-5xl font-light leading-tight text-content-muted sm:text-6xl tracking-tight mt-1">
          Writing that's worth something.
        </p>

        <p className="mt-12 text-lg text-content-primary leading-relaxed max-w-lg">
          At Platform, you own your identity. Build a profile that
          exists on your terms. Find an audience that pays, from
          day one.
        </p>

        <div className="mt-12">
          <Link href="/auth?mode=signup" className="btn text-base px-10 py-4">
            Get started: free £5 credit
          </Link>
        </div>
      </section>

      <div className="mt-32 ornament" />
    </div>
  )
}
