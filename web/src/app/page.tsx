import type { Metadata } from 'next'
import HomeRedirect from '../components/layout/HomeRedirect'
import { LandingVessel } from '../components/landing/LandingVessel'

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
// these paths under web/public, shipped at their CAPTURE size (full 1848×1056
// viewport grabs) — the frame is cut to that ratio rather than the images being
// padded or cropped to a chosen frame; see LandingVessel's SHOT_RATIO. If one
// ever goes missing the frame falls back to a faint-disc placeholder rather than
// a broken-image glyph. Keep alt text descriptive, and keep it honest about what
// the shot actually shows.
const SHOTS = [
  {
    src: '/landing/workspace.webp',
    alt: 'The all.haus workspace in light mode: four numbered feeds open side by side as columns on a pale floor, each with its own wall colour and an “add source” bar along the bottom.',
    caption: 'Your feeds, side by side',
  },
  {
    src: '/landing/omnivore.webp',
    alt: 'The same workspace in dark mode: four feeds whose posts are marked via Bluesky, via Nostr and via RSS — a Guardian headline column beside Substack essays beside Bluesky replies.',
    caption: 'Bluesky, Nostr, RSS — read together',
  },
  {
    src: '/landing/reader.webp',
    alt: 'Reading an article on all.haus: the prose breaks at a “Keep reading” panel offering to continue for £0.75, with a subscription offered as the alternative.',
    caption: 'Read it — pay a few pence',
  },
]

export default function HomePage() {
  return (
    // No topbar: every route is chromeless now, and the one piece of chrome a
    // visitor meets is the nav row LayoutShell mounts at the foot of the
    // viewport. A visitor meets the member grammar — bone floor, one ⊔ vessel
    // at the 8px lattice, cards — with none of the feed furniture that grammar
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
    // `/` KEEPS ITS OWN CHASSIS rather than moving onto PublicShell, and this is
    // the same exception that gives it the doubled wall: it is the only public
    // page whose vessel IS the page, at the prose measure, tuned to its own
    // headroom. PublicShell serves the pages that ask the visitor for something.
    // What `/` no longer owns is the ROW — that was `LandingNavRow`, an in-flow
    // 56px band at the end of this column, now superseded by the fixed
    // `PublicNavRow` LayoutShell mounts on every non-workspace route. The space
    // it used to occupy in the flow is reserved here instead, as
    // `--ah-row-band` (NAV_ROW_H + GRID) of bottom padding — which comes to
    // exactly what the in-flow row plus the vessel area's old 8px bottom
    // padding did, so nothing moves.
    //
    // The floor is `--ah-bone`, a neutral slug, so it inverts with the global
    // toggle. It is also the vessel's own interior colour under `basic`, which
    // is the point of choosing that colourway here: the walls read as ink rules
    // laid on a continuous ground rather than as a box drawn around content.
    // Painting it on THIS element — the full 100dvh, with the band inside as
    // padding — is what keeps the band's clearance above the row bone rather
    // than letting `body` show through it.
    <div
      style={{
        background: 'var(--ah-bone)',
        height: '100dvh',
        paddingBottom: 'var(--ah-row-band, 0px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <HomeRedirect />

      {/* Vessel area — fills all space above the nav row's reserved band and
          centres the column. On desktop its side padding is the bone floor
          showing around the vessel; ON MOBILE THAT MARGIN GOES and the vessel
          runs the full viewport width, which is why the padding lives in
          `.ah-landing-area` (globals.css §1c) rather than inline: the page is
          SSR'd, so the switch has to be a media query. No bottom padding
          either way — the band on the parent carries it. */}
      <div
        className="ah-landing-area"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          justifyContent: 'center',
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
    </div>
  )
}
