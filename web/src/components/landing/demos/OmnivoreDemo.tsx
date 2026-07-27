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
// SCALE. This runs at the LARGEST base of the three demos, because it is the
// one carrying content the visitor is meant to actually read. See the register
// note in LandingVessel.
// =============================================================================

// Base size lives in globals.css §1d (`.ah-demo-omnivore`): 14.5px desktop,
// 13.5px mobile. It stays the largest of the three at both sizes — it is the
// demo carrying content a visitor is meant to read.

// THE BYLINES AND BODIES ARE INVENTED — see the note in WorkspaceDemo. It
// matters most here, because this is the demo shown at near-true size and the
// one whose content a visitor is actually meant to read: a real name attached
// to a retyped post is a claim we have no right to make, and a real name
// attached to an invented post is worse. The protocol labels are the only part
// that must stay literally true, because they are the argument.
export function OmnivoreDemo({ palette }: { palette: VesselPalette }) {
  return (
    <div className="ah-demo-omnivore">
      <DemoVessel palette={palette}>
        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Marguerite Oyelaran" time="5d" />
          <DemoTitle palette={palette}>The Ravelin</DemoTitle>
          <DemoBody palette={palette}>
            The Ravelin is the prettiest magazine I&rsquo;ve reviewed so far.
            Perfect-bound, 130-odd pages, matte covers, uncoated white paper and
            full-colour images&hellip;
          </DemoBody>
          <DemoTag palette={palette}>via RSS &middot; The Common Room &rarr;</DemoTag>
        </DemoPost>

        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Ines Bergqvist" time="6h" />
          <DemoBody palette={palette}>
            The timetable change already fixed this. Ridership didn&rsquo;t fall
            &mdash; if anything the evening trains are fuller.
          </DemoBody>
          <DemoQuote palette={palette} source="Quoting Northgate Transit">
            The operators running before the change were already carrying more
            passengers, and doing it better.
          </DemoQuote>
          <DemoTag palette={palette}>
            via Bluesky &middot; bergqvist.bsky.social &rarr;
          </DemoTag>
        </DemoPost>

        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Aurelio Frame" time="7h" />
          <DemoBody palette={palette}>
            Hell yeah, brother! Did you make it out this time around? I wish I
            could have gone but work took a different path for me since last
            year.
          </DemoBody>
          <DemoTag palette={palette}>via Nostr &middot; aurelio@driftpost.net &rarr;</DemoTag>
        </DemoPost>

        <DemoPost palette={palette}>
          <DemoByline palette={palette} name="Ellis Marchetti" time="6d" paid />
          <DemoTitle palette={palette}>Open Thread 443</DemoTitle>
          <DemoBody palette={palette}>
            This is the weekly visible open thread. Post about anything you want,
            ask random questions, whatever.
          </DemoBody>
          <DemoTag palette={palette}>via RSS &middot; The Slow Hour &rarr;</DemoTag>
        </DemoPost>
      </DemoVessel>
    </div>
  )
}
