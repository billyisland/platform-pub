import Link from 'next/link'

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-article px-6 pt-16 pb-16 lg:pt-8">
      <h1 className="font-serif text-4xl font-light text-ink-900 mb-4 tracking-tight">
        How Platform works
      </h1>
      <p className="text-lg text-content-secondary leading-relaxed mb-16 max-w-lg">
        A publishing platform where writers own their identity and readers pay only for what they read.
      </p>

      <div className="rule-accent mb-16" />

      {/* Identity */}
      <section className="mb-16">
        <h2 className="font-serif text-2xl font-light text-ink-900 mb-4 tracking-tight">Your identity is yours</h2>
        <div className="space-y-4 text-content-primary leading-relaxed">
          <p>
            When you create a Platform account, we generate a Nostr keypair for you. This is a cryptographic identity that belongs to you, not to us. Your articles and notes are signed with your key and published to an open protocol.
          </p>
          <p>
            At any time, you can take custody of your own keys and move your identity off Platform entirely. Your content, your followers, your reputation — none of it is locked in.
          </p>
          <p>
            We hold your keys in trust to make things simple at the start. When you're ready to manage them yourself, we'll help you make the transition.
          </p>
        </div>
      </section>

      {/* Payment */}
      <section className="mb-16">
        <h2 className="font-serif text-2xl font-light text-ink-900 mb-4 tracking-tight">Pay per read, not per month</h2>
        <div className="space-y-4 text-content-primary leading-relaxed">
          <p>
            There are no subscriptions to Platform itself. When you read a paywalled article, the cost is added to your reading tab. Your tab settles at &pound;8, or monthly — whichever comes first.
          </p>
          <p>
            Your first &pound;5 of reading is free. No card required. After that, add a payment method and keep reading. Every penny goes to the writers you read, minus an 8% platform fee.
          </p>
          <p>
            Once you've paid to read an article, it's yours forever. You can come back to it as many times as you like without paying again.
          </p>
        </div>
      </section>

      {/* Writers */}
      <section className="mb-16">
        <h2 className="font-serif text-2xl font-light text-ink-900 mb-4 tracking-tight">For writers</h2>
        <div className="space-y-4 text-content-primary leading-relaxed">
          <p>
            Any reader becomes a writer the moment they publish something worth paying for. There's no application process, no editorial gate.
          </p>
          <p>
            Set your own prices. The editor suggests a price based on word count, but you have the final say. Place the paywall wherever you want in the text — let readers see enough to know if they want the rest.
          </p>
          <p>
            Connect a bank account via Stripe to receive your earnings. Payouts happen monthly, once your balance clears the transfer threshold.
          </p>
        </div>
      </section>

      {/* Notes */}
      <section className="mb-16">
        <h2 className="font-serif text-2xl font-light text-ink-900 mb-4 tracking-tight">Notes and articles</h2>
        <div className="space-y-4 text-content-primary leading-relaxed">
          <p>
            Articles are long-form pieces with optional paywalls, rich text, and images. They're published to the Nostr network as NIP-23 events.
          </p>
          <p>
            Notes are short-form posts — quick thoughts, links, images. Think of them as the social layer. Notes are always free.
          </p>
          <p>
            Both appear in your followers' feeds, interleaved chronologically. Follow writers whose work you enjoy and everything they publish will appear in your feed.
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
