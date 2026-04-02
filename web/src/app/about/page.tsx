import Link from 'next/link'
import { ThereforeMark } from '../../components/icons/ThereforeMark'

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-article px-6 pt-16 pb-16 lg:pt-8">
      <h1 className="font-serif text-4xl font-medium text-black mb-4" style={{ letterSpacing: '-0.02em' }}>
        Platform
      </h1>
      <p className="text-lg text-grey-600 leading-relaxed mb-16 max-w-lg">
        A place to write, publish and get paid
      </p>

      <div className="space-y-4 text-black leading-relaxed mb-16">
        <p>
          Writers post Articles (which can be paywalled) and Notes (which can&rsquo;t). Readers follow for free, or subscribe monthly to unlock everything a writer puts behind a paywall. Prefer to browse? Pay as you go: unlock individual pieces for very small fees.
        </p>
        <p>
          Charges accumulate on a Tab (think bar tab) and settle through Stripe. Writers get paid the same way, in batches, once the balance is big enough that transaction fees won&rsquo;t eat it.
        </p>

        <h2 className="font-serif text-xl font-medium text-black pt-4" style={{ letterSpacing: '-0.01em' }}>
          Built on open ground
        </h2>
        <p>
          Platform runs on Nostr, an open-source, peer-to-peer messaging protocol popular with privacy advocates, libertarians and Bitcoin enthusiasts. You don&rsquo;t need to be any of those things to like what it makes possible.
        </p>
        <p>
          By default, Platform hosts your content and manages your payments, taking an 8% cut to cover running costs. But your account, your content, your follows, and your reading permissions are all genuinely portable. Your identity is a cryptographic key pair held in a secure locker that Platform can&rsquo;t read. You can move it to another custodian, a browser extension, or a piece of paper whenever you like. If you don&rsquo;t like what Platform is doing, leave for another host (or run your own) taking your followers, your payment receipts, and your self-respect with you.
        </p>

        <h2 className="font-serif text-xl font-medium text-black pt-4" style={{ letterSpacing: '-0.01em' }}>
          You don&rsquo;t need to think about any of that
        </h2>
        <p>
          Sign up, log in with Google if you like, and use what looks and feels like a straightforward web app. Your account comes with &pound;5 of credit to get started. When it runs out, connect a payment method and carry on &mdash; safe in the knowledge that your Platform account is genuinely yours.
        </p>
      </div>

      <div className="ornament mb-12">
        <ThereforeMark size={24} weight="light" />
      </div>

      <div className="text-center">
        <Link href="/auth?mode=signup" className="btn text-base px-10 py-4">
          Get started: free &pound;5 credit
        </Link>
      </div>
    </div>
  )
}
