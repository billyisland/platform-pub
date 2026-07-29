import {
  DemoVessel,
  DemoPost,
  DemoByline,
  DemoTitle,
  DemoBody,
  DemoTag,
  DemoQuote,
} from './primitives'
import type { VesselPalette } from '../../workspace/tokens'

// =============================================================================
// OmnivoreDemo — ONE feed column, at a size you can actually read.
//
// This is the demo that most needed rebuilding. Its predecessor was a 1848×1056
// viewport capture shown 640px wide: a 2.9× reduction, which put the app's 15px
// body type at roughly 5px. The four VIA lines — the entire argument — were the
// first thing to dissolve, so the picture proved nothing the caption hadn't
// already asserted.
//
// A SINGLE COLUMN is what fixes it. At the prose measure one feed renders at
// very nearly its true size, so the origin tags read as text rather than as
// grey texture, and a visitor can see that a Bluesky reply, an RSS essay and a
// Nostr note are sitting in one stack, in one card grammar, without being told.
// Four cards, four protocols; the crimson pip on the last one is the only
// forward reference to the payment argument below.
//
// THE FOUR BODIES ARE THE PAGE'S ONLY READABLE COPY, so they carry the weight of
// the mix the pitch is claiming: a print critic, a reply that turns a reported
// fact into an accusation, somebody standing in a field at four in the morning,
// and a paid essay. Chatter and journalism in one column, which is the argument.
//
// THE PAID CARD IS THE PIECE THE READER DEMO OPENS — deliberately, and the one
// post repeated anywhere on the page (see the note in CanvasDemo, which forbids
// the rest). Ellis Marchetti's "The difficult second read" is priced here and
// gated there, so a visitor scrolling down meets the same article twice and the
// paywall lands on something they have already been given a reason to want.
//
// SCALE. This runs at the LARGEST base of the three demos, because it is the
// one carrying content the visitor is meant to actually read. See the register
// note in LandingVessel.
// =============================================================================

// Base size lives in globals.css §1d (`.ah-demo-omnivore`): 14.5px desktop,
// 13.5px mobile. It stays the largest of the three at both sizes — it is the
// demo carrying content a visitor is meant to read.

// THE BYLINES AND BODIES ARE INVENTED — see the note in CanvasDemo. It
// matters most here, because this is the demo shown at near-true size and the
// one whose content a visitor is actually meant to read: a real name attached
// to a retyped post is a claim we have no right to make, and a real name
// attached to an invented post is worse. The protocol labels are the only part
// that must stay literally true, because they are the argument.
export function OmnivoreDemo({ palette }: { palette: VesselPalette }) {
  return (
    <div className="ah-demo-omnivore">
      {/* This demo is the FIXED-SIZE figure, so it owns its ⊔ inline. The other
          two omit `wall` and take their geometry from §1d, because they scale in
          `em` off a container query — see the two-mode note in primitives. */}
      <DemoVessel palette={palette} wall={8}>
        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Marguerite Oyelaran" time="5d" />
          <DemoTitle palette={palette}>The Ravelin</DemoTitle>
          <DemoBody palette={palette}>
            The prettiest magazine anyone has sent me all year. Perfect-bound,
            130-odd pages, matte covers, uncoated stock, full-colour plates
            &mdash; and they are charging less for it than a pint&hellip;
          </DemoBody>
          <DemoTag palette={palette}>via RSS &middot; The Common Room &rarr;</DemoTag>
        </DemoPost>

        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Ines Bergqvist" time="6h" />
          <DemoBody palette={palette}>
            Eleven times. At some point &ldquo;we can&rsquo;t find it&rdquo;
            stops being an accident and becomes a decision.
          </DemoBody>
          <DemoQuote palette={palette} source="Quoting The Meridian">
            We have asked the council eleven times to produce the harbour lease.
            Eleven times we have been told it is being looked for.
          </DemoQuote>
          <DemoTag palette={palette}>
            via Bluesky &middot; bergqvist.bsky.social &rarr;
          </DemoTag>
        </DemoPost>

        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Aurelio Frame" time="7h" />
          <DemoBody palette={palette}>
            Up at the point at four this morning for the meteors. Saw exactly
            two, froze solid, drank the worst coffee of my life, and would do the
            whole thing again tonight.
          </DemoBody>
          <DemoTag palette={palette}>via Nostr &middot; aurelio@driftpost.net &rarr;</DemoTag>
        </DemoPost>

        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Ellis Marchetti" time="6d" paid />
          <DemoTitle palette={palette}>The difficult second read</DemoTitle>
          <DemoBody palette={palette}>
            No book has ever changed my mind on the first pass. They sit on the
            shelf for a year, or five, waiting for me to become someone who can
            hear them&hellip;
          </DemoBody>
          <DemoTag palette={palette}>via RSS &middot; The Slow Hour &rarr;</DemoTag>
        </DemoPost>
      </DemoVessel>
    </div>
  )
}
