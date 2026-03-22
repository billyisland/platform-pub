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

      <div className="space-y-4 text-content-primary leading-relaxed mb-16">
        <p>
          Post Articles (which can be paywalled) and Notes (which can't). Follow other writers for free, or Subscribe for a monthly fee to unlock everything they put behind a paywall. Or, if you'd rather read widely and see the best of what everyone has to offer, pay as you go, unlocking individual pieces for very small fees.
        </p>
        <p>
          Charges accumulate on a Tab (think of it like a bar tab) and settle through Stripe. Writers receive their earnings the same way, in batches, once the balance is big enough that it won't get eaten by transaction charges.
        </p>
        <p>
          Unlike most social networks you're likely to have come across, Platform is built on an open-source, peer-to-peer messaging protocol. Nostr is its name, and it's very popular with privacy advocates, libertarians, and people who are into Bitcoin. You don't have to be any of those things to appreciate what it has to offer, though.
        </p>
        <p>
          By default, Platform hosts your content and manages your payments. In return, it takes an 8% cut to cover running costs and asks that you adhere to its content policy. Thanks to Nostr, though, your account, your content, your follows, and your reading permissions are all genuinely portable. Your identity is a cryptographic key pair held in a secure locker that Platform can't read, and you're welcome to move it to another custodian, a browser extension or a piece of paper whenever you like. If there's anything you don't like about what Platform is doing, you can leave for another host — or even run your own, taking your followers, your payment receipts and your self-respect with you.
        </p>
        <p>
          You don't need to think about any of that. In the normal course of things you sign up, maybe log in with Google, and use what looks and feels like a straightforward web app. Your account comes with &pound;5 of credit to get you started. Once that runs out, you connect a payment method and carry on, safe in the knowledge that your Platform account is genuinely yours. Take it and do whatever you want with it.
        </p>
      </div>

      <div className="ornament mb-12" />

      <div className="text-center">
        <Link href="/auth?mode=signup" className="btn text-base px-10 py-4">
          Get started: free &pound;5 credit
        </Link>
      </div>
    </div>
  )
}
