import { paletteFor, type VesselPalette } from '../../workspace/tokens'
import { DemoVessel, DemoPost, DemoByline, DemoTitle, DemoBody, DemoTag, DemoQuote, DemoPhoto } from './primitives'

// =============================================================================
// CanvasDemo — feeds as OBJECTS ON A CANVAS. Supersedes WorkspaceDemo.
//
// WHAT WAS WRONG WITH THE THREE-COLUMN VERSION. It showed three feeds of equal
// width, equal height, equally spaced — which is the weakest possible reading of
// the claim. Three identical columns say "this app has columns", a thing every
// app has had since 2004. What the workspace actually does is let a feed be any
// SIZE, in any POSITION, at either ORIENTATION, and that is the interesting part
// and the part no screenshot in the old set ever showed. So this arrangement is
// deliberately irregular:
//
//   1 — WIDE and tall, top left. The feed you read: full cards, and the one
//       carrying a picture, so the grammar is seen holding one.
//   2 — NARROW, top right, at HEADLINE density — source and title, nothing else.
//       Literally what the arrangement claims: a feed that doesn't need width
//       has been given none, and has been told to stop showing standfirsts.
//   3 — NARROW, under 2. Two feeds sharing one column of canvas.
//   4 — HORIZONTAL, under 1, cards running off to the right under a gradient.
//       The orientation flip is the thing here: the same cards, the same
//       grammar, turned sideways.
//
// THE ARRANGEMENT IS A LEGAL FLOOR, and that is not decoration. The workspace
// floor is COLUMNAR (WORKSPACE-COLUMN-LAYOUT-ADR): an order of columns, each an
// ordered stack of slots, and slots in one column may differ in width. So this
// is two columns — [1, 4] and [2, 3] — with the two rows interlocking, which is
// a shape a user could actually build. The previous version ran feed 4 as a band
// across the full width UNDER both columns, which no stored order can express;
// it read as a footer rather than as a feed, because that is the only thing a
// full-width band under two columns can read as.
//
// Four colourways rather than three (basic, spring, winter, autumn), so the
// per-feed wall colour reads as a system rather than as decoration. All resolved
// through paletteFor with the page's dark flag, so they invert for free and
// follow any future retune of the seasonal surfaces.
//
// -----------------------------------------------------------------------------
// THE MOBILE FIX, AND WHY IT IS A CONTAINER QUERY AND NOT A MEDIA QUERY.
//
// The previous version reflowed to two columns under a viewport media query and
// fell apart: the grid was sized against a guess at the viewport, not against
// the width the demo was actually handed, and any card padding change upstream
// threw it out. Worse, reflowing was the wrong move in principle — the
// ARRANGEMENT IS THE MESSAGE here, so a mobile version that rearranges the
// feeds into a tidy stack demonstrates the opposite of the claim.
//
// So the arrangement never changes. What changes is scale: the wrapper is a
// container (`container-type: inline-size`), the grid's base font-size is
// `clamp(8.5px, 1.95cqw, 12px)`, and every measurement inside — type, padding,
// gaps, wall thickness, the bar — is `em`. The whole canvas therefore scales
// with the space it is given, at any width, without knowing anything about the
// viewport. It cannot be knocked out of true by a padding change upstream,
// because it is measuring the actual container.
//
// The canvas is a FIXED BOX (a height in `em`) whose feeds clip, exactly as
// vessels on the floor do — see the long note in §1d. Nothing is hidden at any
// width and no card changes shape; only the scale moves. The earlier version
// shed card bodies and provenance tags below 430px of container, which halved
// every card height at that one width and left the vertical feeds showing bare
// bylines. The arrangement, which is the argument, survives intact at every
// width because the arrangement is the one thing that never varies.
//
// THIS IS A DEPARTURE FROM §1c's RULE and the reason it is safe: §1c insists on
// media queries because `/` is SSR'd and a JS breakpoint would paint the wrong
// form factor before hydration. A container query is still CSS — it resolves at
// paint, on the server-rendered markup, with no JS and no hydration snap. It
// gets the SSR safety AND measures the right thing.
// -----------------------------------------------------------------------------
// =============================================================================

interface DemoCard {
  name: string
  time: string
  title?: string
  body?: string
  tag: string
  paid?: boolean
  photo?: boolean
  quote?: { source: string; text: string }
}

/**
 * The bottom band. Stands in for VesselBar, carrying only the numeral.
 *
 * IT IS THE BOTTOM OF THE VESSEL, NOT A ROW SITTING ON IT — "the bottom wall is
 * replaced by VesselBar" (Vessel.tsx). Hence the negative margins, which take it
 * out through the interior padding to the inside faces of the walls, and hence
 * `marginTop: auto`, which pins it to the floor of a vessel the grid has
 * stretched taller than its cards. Drawing a bottom wall UNDER this — which is
 * what the canvas used to do — put two bands of two different colours across the
 * foot of every feed, and was the single thing that made the vessels read wrong.
 */
function DemoBar({ palette, numeral }: { palette: VesselPalette; numeral: number }) {
  return (
    <div
      style={{
        background: palette.barBg,
        height: '2.1em',
        display: 'flex',
        alignItems: 'center',
        padding: '0 0.9em',
        marginTop: 'auto',
        marginLeft: '-1.1em',
        marginRight: '-1.1em',
        marginBottom: '-1.1em',
        flex: 'none',
      }}
    >
      <span className="font-mono" style={{ color: palette.barText, fontSize: '0.9em', fontWeight: 500 }}>
        {numeral}
      </span>
    </div>
  )
}

/**
 * One card. `density` mirrors the real per-feed control: `standard` is the full
 * card, `headline` is source + title and nothing else — no standfirst, no media,
 * no quote — on the tighter 8/12 padding the condensed family uses (chassis.tsx).
 */
function Card({
  palette,
  card,
  density = 'standard',
}: {
  palette: VesselPalette
  card: DemoCard
  density?: 'standard' | 'headline'
}) {
  const headline = density === 'headline'

  return (
    <DemoPost palette={palette} padding={headline ? '0.55em 0.82em' : '1.1em'}>
      <DemoByline palette={palette} name={card.name} time={card.time} paid={card.paid} />
      {card.title ? <DemoTitle palette={palette}>{card.title}</DemoTitle> : null}

      {!headline && card.body ? <DemoBody palette={palette}>{card.body}</DemoBody> : null}

      {!headline && card.photo ? <DemoPhoto palette={palette} /> : null}

      {!headline && card.quote ? (
        <DemoQuote palette={palette} source={card.quote.source}>
          {card.quote.text}
        </DemoQuote>
      ) : null}

      <DemoTag palette={palette}>{card.tag}</DemoTag>
    </DemoPost>
  )
}

// THE BYLINES, PUBLICATIONS, HANDLES AND BODIES ARE INVENTED, and must stay that
// way. The captures these demos replaced showed real posts by real people, which
// is defensible in a screenshot and is not defensible here: retyped as markup, a
// named person's post is indistinguishable from words we put in their mouth, on
// a page whose job is to sell something. Invented names cost the demo nothing —
// the claim is "feeds are objects you arrange", and no part of it needs a real
// byline to land. The people and publications are shared with OmnivoreDemo and
// ReaderDemo so the demos read as one coherent invented world rather than three.
// The protocol labels are the exception and must stay literally true: they ARE
// the omnivore argument.
const FEED_1: DemoCard[] = [
  {
    name: 'Tobias Wren',
    time: '5d',
    title: 'A theory of power',
    body: 'There are many considerations in appointing a cabinet: rewarding loyal supporters, balancing factions, keeping rivals well away from the spotlight…',
    photo: true,
    tag: 'via RSS · The Whip Room',
  },
  {
    name: 'Ines Bergqvist',
    time: '6h',
    body: 'The timetable change already fixed this. Ridership didn’t fall — if anything the evening trains are fuller.',
    quote: {
      source: 'Quoting Northgate Transit',
      text: 'The operators running before the change were already carrying more passengers, and doing it better.',
    },
    tag: 'via Bluesky',
  },
  {
    name: 'Ellis Marchetti',
    time: '6d',
    paid: true,
    title: 'Open Thread 443',
    body: 'This is the weekly visible open thread. Post about anything you want, ask random questions, whatever.',
    tag: 'via RSS · The Slow Hour',
  },
  {
    name: 'The Meridian',
    time: '1w',
    title: 'Who actually owns the harbour?',
    body: 'Four holding companies, two of them registered last spring, and a lease nobody at the council can produce…',
    tag: 'via RSS · The Meridian',
  },
]

// Feed 2 runs at HEADLINE density, so these carry titles and no bodies: a
// standfirst written here would simply never render, and leaving one in would
// invite someone to "fix" the density later by showing it.
const FEED_2: DemoCard[] = [
  { name: 'The Meridian', time: '1h', title: 'Harbour scheme approved after a decade of objections', tag: 'via RSS' },
  { name: 'Fenwick Wire', time: '2h', title: 'Veteran striker signs one more year at thirty-eight', tag: 'via RSS' },
  { name: 'The Meridian', time: '3h', title: 'Two more ward surgeries to close by the spring', tag: 'via RSS' },
  { name: 'Northgate Transit', time: '5h', title: 'Evening timetable holds after the winter review', tag: 'via Nostr' },
  { name: 'Fenwick Wire', time: '6h', title: 'Rain forces a third postponement at the Ravelin', tag: 'via RSS' },
  { name: 'The Meridian', time: '8h', title: 'Harbour board names its interim chair', tag: 'via RSS' },
  { name: 'Northgate Transit', time: '11h', title: 'Weekend engineering works pushed to March', tag: 'via Nostr' },
]

const FEED_3: DemoCard[] = [
  { name: 'Halloran', time: '1h', body: 'Are the high-street cinemas owned by private equity now?', tag: 'via Bluesky' },
  { name: 'Aurelio Frame', time: '7h', body: 'Hell yeah, brother! Did you make it out this time?', tag: 'via Nostr' },
  { name: 'Ines Bergqvist', time: '9h', body: 'Third week of the new timetable and the 6.40 is still standing room only.', tag: 'via Bluesky' },
  { name: 'Halloran', time: '1d', body: 'Someone has repainted the ravelin gates and nobody will admit to it.', tag: 'via Nostr' },
  { name: 'Aurelio Frame', time: '1d', body: 'Two years of asking and the harbour board has finally published the seabed survey.', tag: 'via Nostr' },
  { name: 'Marguerite Oyelaran', time: '2d', body: 'Print run sold through by Thursday. We are doing another one.', tag: 'via Bluesky' },
]

const FEED_4: DemoCard[] = [
  { name: 'Marguerite Oyelaran', time: '5d', title: 'The Ravelin', body: 'The prettiest magazine I’ve reviewed so far…', tag: 'via RSS' },
  { name: 'Ellis Marchetti', time: '6d', paid: true, title: 'Your Book Review', body: 'One of the finalists in this year’s book review contest…', tag: 'via RSS' },
  { name: 'Rosalind Vane', time: '6d', title: 'Finding an agent', body: 'I have several friends looking for agents…', tag: 'via RSS' },
  { name: 'Tobias Wren', time: '1w', title: 'Summer reruns', body: 'We are now in the period which TV controllers used to call…', tag: 'via RSS' },
]

export function CanvasDemo({ dark }: { dark: boolean }) {
  const p1 = paletteFor('basic', dark)
  const p2 = paletteFor('spring', dark)
  const p3 = paletteFor('winter', dark)
  const p4 = paletteFor('autumn', dark)

  return (
    <div className="ah-demo-canvas-wrap">
      {/* Two COLUMNS of slots, which is the floor's own structure — see §1d.
          Column A is the article feed over the sideways one; column B is the
          headline feed over the chatter. */}
      <div className="ah-demo-canvas">
        <div className="ah-demo-col ah-demo-col-a">
          {/* `ah-demo-stack` is the scroll body: it clips, so every feed holds
              more cards than fit and the last one is cut off at the bar — which
              is what a vessel on the floor actually looks like, and the only way
              two columns of the same height can both stay full. */}
          <DemoVessel palette={p1} className="ah-demo-c1">
            <div className="ah-demo-stack">
              {FEED_1.map((c, i) => (
                <Card key={i} palette={p1} card={c} />
              ))}
            </div>
            <DemoBar palette={p1} numeral={1} />
          </DemoVessel>

          {/* The sideways one — a ⊐, not a ⊔. A horizontal vessel closes TOP and
              RIGHT and opens on the LEFT, where newest items arrive; older ones
              run off to the right, which is why the row is clipped there under a
              gradient. (A horizontal feed shown statically has to be clipped to
              read as scrollable: a row that ends tidily reads as a row that has
              ended.) The gradient is to the vessel INTERIOR, so it looks like
              the floor continuing rather than a fade to white. Wall arrangement
              per Vessel.tsx; the geometry itself is §1d's `.ah-demo-c4`. */}
          <DemoVessel palette={p4} className="ah-demo-c4">
            <div className="ah-demo-hrow" style={{ ['--ah-demo-floor' as string]: p4.interior }}>
              {FEED_4.map((c, i) => (
                <Card key={i} palette={p4} card={c} />
              ))}
            </div>
            <DemoBar palette={p4} numeral={4} />
          </DemoVessel>
        </div>

        <div className="ah-demo-col ah-demo-col-b">
          {/* Headline density: source + title, on the tighter card padding. */}
          <DemoVessel palette={p2} className="ah-demo-c2">
            <div className="ah-demo-stack">
              {FEED_2.map((c, i) => (
                <Card key={i} palette={p2} card={c} density="headline" />
              ))}
            </div>
            <DemoBar palette={p2} numeral={2} />
          </DemoVessel>

          <DemoVessel palette={p3} className="ah-demo-c3">
            <div className="ah-demo-stack">
              {FEED_3.map((c, i) => (
                <Card key={i} palette={p3} card={c} />
              ))}
            </div>
            <DemoBar palette={p3} numeral={3} />
          </DemoVessel>
        </div>
      </div>
    </div>
  )
}
