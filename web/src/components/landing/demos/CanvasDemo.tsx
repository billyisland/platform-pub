import { paletteFor, type VesselPalette } from '../../workspace/tokens'
import { DemoVessel, DemoPost, DemoByline, DemoTitle, DemoBody, DemoTag, DemoQuote } from './primitives'

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
//   1 — WIDE and tall, left, running the demo's full height. The feed you read.
//   2 — NARROW, top right. Headlines; it doesn't need the width.
//   3 — NARROW, STACKED under 2. Two feeds sharing one column of canvas.
//   4 — HORIZONTAL, full width along the bottom, cards running off its own right
//       edge under a gradient. The orientation flip is the thing here: the same
//       cards, the same grammar, turned sideways.
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
// The one concession below 430px of container width is that the card BODIES and
// provenance tags hide, leaving bylines and titles. Shedding detail keeps what
// remains legible; shrinking everything to fit would reproduce exactly the grey
// texture the screengrabs were replaced for. The arrangement, which is the
// argument, survives intact at every width.
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
  body: string
  tag: string
  paid?: boolean
  quote?: { source: string; text: string }
}

/** The bottom band. Stands in for VesselBar; carries only the numeral. */
function DemoBar({ palette, numeral }: { palette: VesselPalette; numeral: number }) {
  return (
    <div
      style={{
        background: palette.barBg,
        height: '1.9em',
        display: 'flex',
        alignItems: 'center',
        padding: '0 0.7em',
        margin: '0 -0.45em -0.45em',
      }}
    >
      <span className="font-mono" style={{ color: palette.barText, fontSize: '0.9em', fontWeight: 500 }}>
        {numeral}
      </span>
    </div>
  )
}

function Card({ palette, card }: { palette: VesselPalette; card: DemoCard }) {
  return (
    <DemoPost palette={palette} padding="0.75em 0.85em">
      <DemoByline palette={palette} name={card.name} time={card.time} paid={card.paid} />
      {card.title ? <DemoTitle palette={palette}>{card.title}</DemoTitle> : null}
      <div className="ah-demo-detail">
        <DemoBody palette={palette}>{card.body}</DemoBody>
      </div>
      {card.quote ? (
        <div className="ah-demo-detail">
          <DemoQuote palette={palette} source={card.quote.source}>
            {card.quote.text}
          </DemoQuote>
        </div>
      ) : null}
      <div className="ah-demo-detail">
        <DemoTag palette={palette}>{card.tag}</DemoTag>
      </div>
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
    body: 'There are many considerations in appointing a cabinet: rewarding loyal supporters, balancing factions, keeping rivals away from the spotlight and, ideally, competence…',
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
]

const FEED_2: DemoCard[] = [
  { name: 'The Meridian', time: '1h', body: 'Harbour scheme approved after a decade of objections…', tag: 'via RSS' },
  { name: 'Fenwick Wire', time: '2h', body: 'Veteran striker signs one more year at thirty-eight…', tag: 'via RSS' },
]

const FEED_3: DemoCard[] = [
  { name: 'Halloran', time: '1h', body: 'Are the high-street cinemas owned by private equity now?', tag: 'via Bluesky' },
  { name: 'Aurelio Frame', time: '7h', body: 'Hell yeah, brother! Did you make it out this time?', tag: 'via Nostr' },
]

const FEED_4: DemoCard[] = [
  { name: 'Marguerite Oyelaran', time: '5d', title: 'The Ravelin', body: 'The prettiest magazine I’ve reviewed so far…', tag: 'via RSS' },
  { name: 'Rosalind Vane', time: '6d', title: 'Finding an agent', body: 'I have several friends looking for agents…', tag: 'via RSS' },
  { name: 'Ellis Marchetti', time: '1w', paid: true, title: 'Your Book Review', body: 'One of the finalists in the 2026 book review contest…', tag: 'via RSS' },
  { name: 'Tobias Wren', time: '1w', title: 'Summer reruns', body: 'We are now in the period which TV controllers used to call…', tag: 'via RSS' },
]

export function CanvasDemo({ dark }: { dark: boolean }) {
  const p1 = paletteFor('basic', dark)
  const p2 = paletteFor('spring', dark)
  const p3 = paletteFor('winter', dark)
  const p4 = paletteFor('autumn', dark)

  return (
    <div className="ah-demo-canvas-wrap">
      <div className="ah-demo-canvas">
        <DemoVessel palette={p1} className="ah-demo-c1">
          {FEED_1.map((c, i) => (
            <Card key={i} palette={p1} card={c} />
          ))}
          <DemoBar palette={p1} numeral={1} />
        </DemoVessel>

        <DemoVessel palette={p2} className="ah-demo-c2">
          {FEED_2.map((c, i) => (
            <Card key={i} palette={p2} card={c} />
          ))}
          <DemoBar palette={p2} numeral={2} />
        </DemoVessel>

        <DemoVessel palette={p3} className="ah-demo-c3">
          {FEED_3.map((c, i) => (
            <Card key={i} palette={p3} card={c} />
          ))}
          <DemoBar palette={p3} numeral={3} />
        </DemoVessel>

        {/* The sideways one. The cards run off the vessel's own right edge under
            a gradient — a horizontal feed shown statically has to be CLIPPED to
            read as scrollable; a row that ends tidily reads as a row that has
            ended. The gradient is to the vessel INTERIOR, so it looks like the
            floor continuing rather than a fade to white. */}
        <DemoVessel palette={p4} className="ah-demo-c4">
          <div className="ah-demo-hrow" style={{ ['--ah-demo-floor' as string]: p4.interior }}>
            {FEED_4.map((c, i) => (
              <Card key={i} palette={p4} card={c} />
            ))}
          </div>
          <DemoBar palette={p4} numeral={4} />
        </DemoVessel>
      </div>
    </div>
  )
}
