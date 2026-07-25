import type { Metadata } from 'next'
import HomeRedirect from '../components/layout/HomeRedirect'
import { LandingVessel } from '../components/landing/LandingVessel'
import { LandingNavRow } from '../components/landing/LandingNavRow'
import { NAV_ROW_H } from '../components/workspace/NavRow'

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

const GRID = 8

const HEADLINE =
  'all.haus is a writing platform dedicated to three radical propositions:'

const PROPOSITIONS = [
  'No one should own the public square.',
  'Keeping up shouldn’t mean being farmed.',
  'Writing is work and deserves to be paid as such.',
]

const PROSE = [
  'Build omnivorous feeds that pull the whole open social web — Bluesky, Mastodon, Substack, plain old RSS — into one place. Sort them with rules you set rather than rules set on you. No dopamine hacks, no algorithm optimised for pointless, endless engagement. A feed is a tool: you need the right one for each job. At all.haus you can create as many as you like.',
  'Read what’s worth reading and pay a few pence for it. No subscription, no bundle, no commitment you’ll forget to cancel. The money goes to whoever wrote the piece, and they set the terms.',
  'The whole thing runs on Nostr: an open protocol with no company behind it, no servers to seize, and no owner to sell it to someone worse.',
]

export default function HomePage() {
  return (
    // The logged-out register is retired on `/` (LayoutShell chromelessRoute):
    // no black topbar, no 60px main offset. A visitor meets the member grammar
    // — bone floor, ⊔ walls at the 8px lattice, cards, the lockup docked at the
    // right end of a nav row — with none of the feed furniture that grammar
    // usually carries. See LandingVessel for what is deliberately absent.
    //
    // The floor is `--ah-bone`, a neutral slug, so it inverts with the global
    // toggle. It is also the vessel's own interior colour under `basic`, which
    // is the point of choosing that colourway here: the walls read as ink rules
    // laid on a continuous ground rather than as a box drawn around content.
    <div
      style={{
        background: 'var(--ah-bone)',
        // dvh, not vh — see LayoutShell: `100vh` is the large (URL-bar-hidden)
        // viewport on mobile, which forces a phantom overflow that rubber-bands.
        minHeight: '100dvh',
        // Reserve the fixed nav row's band so the last line clears it at rest.
        paddingBottom: NAV_ROW_H + GRID,
      }}
    >
      <HomeRedirect />

      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: `${GRID * 8}px ${GRID * 2}px 0`,
        }}
      >
        <LandingVessel
          headline={HEADLINE}
          propositions={PROPOSITIONS}
          prose={PROSE}
        />
      </div>

      <LandingNavRow />
    </div>
  )
}
