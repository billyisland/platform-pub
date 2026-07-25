import type { Metadata } from 'next'
import HomeRedirect from '../components/layout/HomeRedirect'
import { LandingVessel } from '../components/landing/LandingVessel'
import { LandingNavRow } from '../components/landing/LandingNavRow'

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
  'Build omnivorous feeds that pull the whole open social web into one place — Bluesky, Mastodon, Substack, plain old RSS and more. Sort them with rules you set rather than rules set on you. No dopamine hacks, no algorithm optimised for pointless, endless scrolling. A feed is a tool: you need the right one for each job. At all.haus you can create as many as you like.',
  'Read what’s worth reading and pay a few pence for it. You don’t need to subscribe or make financial commitments you’ll forget to cancel. The money goes to whoever wrote the piece, on terms they set.',
  'The whole thing runs on Nostr: an open protocol with no company behind it, no servers to seize, and no owner to sell it to someone worse.',
]

// Live-site screengrabs shown as cards below the sell text. Real images live at
// these paths under web/public, pre-cropped to the frame's 16:10 (LandingShot
// paints them `objectFit: cover`, so shipping any other aspect just throws
// pixels away); if one ever goes missing the frame falls back to a faint-disc
// placeholder rather than a broken-image glyph. Keep alt text descriptive, and
// keep it honest about what the shot actually shows.
const SHOTS = [
  {
    src: '/landing/workspace.webp',
    alt: 'The all.haus workspace: four feeds open side by side as columns, each numbered, on a pale floor.',
    caption: 'Your feeds, side by side',
  },
  {
    src: '/landing/omnivore.webp',
    alt: 'The same workspace in dark mode, its feeds carrying posts marked via Bluesky, via Nostr and via RSS.',
    caption: 'Bluesky, Nostr, RSS — read together',
  },
  {
    src: '/landing/reader.webp',
    alt: 'Reading an article on all.haus: the prose breaks at a “Keep reading” panel offering to continue for a few pence from your reading credit.',
    caption: 'Read it — pay a few pence',
  },
]

export default function HomePage() {
  return (
    // The logged-out register is retired on `/` (LayoutShell chromelessRoute):
    // no black topbar, no 60px main offset. A visitor meets the member grammar
    // — bone floor, one ⊔ vessel at the 8px lattice, cards, the lockup docked at
    // the right end of a nav row — with none of the feed furniture that grammar
    // usually carries. See LandingVessel for what is deliberately absent.
    //
    // AN APP SHELL, NOT A SCROLLING DOCUMENT. The page is a `100dvh` flex column
    // pinned to the viewport (`overflow: hidden`): the vessel area fills the
    // space above the nav row, the vessel fills that area, and the card column
    // scrolls INSIDE the vessel. Nothing scrolls at the document level, so the
    // whole vessel is always on screen and the mobile URL-bar rubber-band (which
    // the earlier document-scroll layout suffered) cannot happen. dvh, not vh —
    // `100vh` is the large (URL-bar-hidden) viewport on mobile.
    //
    // The floor is `--ah-bone`, a neutral slug, so it inverts with the global
    // toggle. It is also the vessel's own interior colour under `basic`, which
    // is the point of choosing that colourway here: the walls read as ink rules
    // laid on a continuous ground rather than as a box drawn around content.
    <div
      style={{
        background: 'var(--ah-bone)',
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <HomeRedirect />

      {/* Vessel area — fills all space above the nav row and centres the column;
          the GRID margins are the bone floor showing around the vessel. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          justifyContent: 'center',
          padding: `${GRID * 3}px ${GRID * 2}px ${GRID}px`,
        }}
      >
        <div
          style={{
            maxWidth: 720,
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <LandingVessel
            headline={HEADLINE}
            propositions={PROPOSITIONS}
            prose={PROSE}
            shots={SHOTS}
          />
        </div>
      </div>

      <LandingNavRow />
    </div>
  )
}
