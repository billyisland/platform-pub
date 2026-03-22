import Link from 'next/link'

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-article px-6 pt-16 pb-16 lg:pt-8">
      <h1 className="font-serif text-4xl font-medium text-ink-900 mb-4" style={{ letterSpacing: '-0.02em' }}>
        Platform
      </h1>
      <p className="text-lg text-content-secondary leading-relaxed mb-16 max-w-lg">
        A place for writers to publish and get paid.
      </p>

      <div className="rule-accent mb-16" />

      <section className="mb-16">
        <div className="space-y-4 text-content-primary leading-relaxed">
          <p>
            You can post Articles (which can be paywalled) and Notes (which can't). Follow other writers for free, or Subscribe for a monthly fee to unlock everything they put behind a paywall. Or, if you'd rather not subscribe, just unlock individual pieces for a small fee: pay-as-you-go.
          </p>
          <p>
            To keep small payments practical, charges accumulate on a Tab (think of it like a bar tab) and settle periodically through Stripe. Writers receive their earnings the same way — in batches, once the balance is worth moving.
          </p>
        </div>
      </section>

      <section className="mb-16">
        <h2 className="font-serif text-2xl font-medium text-ink-900 mb-4" style={{ letterSpacing: '-0.02em' }}>What makes Platform different</h2>
        <div className="space-y-4 text-content-primary leading-relaxed">
          <p>
            The whole thing is built on Nostr. Your identity is a cryptographic key pair, and your proof of purchase for any paywalled content lives with you, not with us. This means your account, your content, your follows, and your reading permissions are all genuinely portable.
          </p>
          <p>
            Most people won't need to think about any of that. In the normal course of things you sign up, maybe log in with Google, and use what looks and feels like a straightforward web app. Your account comes with &pound;5 of credit to get you started. Once that runs out, you connect a payment method and carry on. Platform takes 8% of payments to authors to cover running costs.
          </p>
        </div>
      </section>

      <section className="mb-16">
        <h2 className="font-serif text-2xl font-medium text-ink-900 mb-4" style={{ letterSpacing: '-0.02em' }}>You're free to leave</h2>
        <div className="space-y-4 text-content-primary leading-relaxed">
          <p>
            Platform hosts your content and manages your Tab by default, and asks that you follow its content policies while it does. But if you'd rather do things differently — move to another host, run your own, manage your own keys — you can. Your private key is held in a secure locker that Platform itself can't read, and you're welcome to move it to another custodian, a browser extension, or a piece of paper whenever you like. Your Platform account is genuinely yours. Take it and do whatever you want with it.
          </p>
        </div>
      </section>

      <div className="ornament mb-12" />

      <div className="text-center">
        <Link href="/auth?mode=signup" className="btn text-base px-10 py-4">
          Get started: free &pound;5 credit
        </Link>
      </div>
    </div>
  )
}
