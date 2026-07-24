import type { Metadata } from 'next'
import Link from 'next/link'
import HomeRedirect from '../components/layout/HomeRedirect'
import { ForAllMark } from '../components/icons/ForAllMark'

const TITLE = 'all.haus — No one should own the public square.'
const DESCRIPTION =
  'A writing platform on Nostr: omnivorous feeds sorted by rules you set, and a few pence to whoever wrote the thing.'

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
    // CLOSED-BETA-ADR §IV. Log in lives in the topbar — not repeated.
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-28">
      <HomeRedirect />

      <div className="flex justify-center mb-8">
        <ForAllMark size={36} className="text-crimson" />
      </div>

      <h1
        className="font-serif font-medium text-black tracking-tight text-center"
        style={{ fontSize: '30px' }}
      >
        all.haus is a writing platform dedicated to three propositions:
      </h1>

      <ol className="mt-10 space-y-5">
        {[
          'No one should own the public square.',
          'Keeping up shouldn’t mean being farmed.',
          'Writing is work and deserves to be paid as such.',
        ].map((proposition, i) => (
          <li key={i} className="flex gap-4">
            <span className="font-mono text-crimson text-mono-sm pt-[3px]">
              {i + 1}
            </span>
            <span
              className="font-serif text-black"
              style={{ fontSize: '22px', lineHeight: 1.4 }}
            >
              {proposition}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-12 space-y-6 text-[1.0625rem] font-mono tracking-[0.01em] text-grey-600 leading-relaxed">
        <p>
          Build omnivorous feeds that pull in the whole open social web —
          Bluesky, Mastodon, Substack, plain old RSS — in one place, sorted by
          rules you set rather than rules set on you. No engagement hacks,
          no algorithm optimised against you. A feed is a tool: you need the right
          one for each job. At all.haus you can create as many as you like.
        </p>
        <p>
          Read what&apos;s worth reading and pay a few pence for it. No
          subscription, no bundle, no commitment you&apos;ll forget to cancel.
          The money goes to whoever wrote the thing.
        </p>
        <p>
          It runs on Nostr: an open protocol with no company behind it, no
          servers to seize, and no owner to sell it to someone worse.
        </p>
      </div>

      <div className="mt-12 text-center">
        <Link href="/waitlist" className="btn-accent inline-block">
          Join the waiting list
        </Link>
      </div>
    </div>
  )
}
