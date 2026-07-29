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
//
// THE CAST IS SHARED; THE POSTS ARE NOT. A visitor meets all three demos in one
// scroll, so a card that appears twice reads as the page having run out of
// things to show. No post body, headline or quote is repeated across the three
// files — the shared world is carried by the people and the publications, and by
// one story crossing between them (the Halcyon grid sale is broken in feed 1,
// traded on in feed 1's quote card, mocked in feed 3, quoted by a Bluesky reply
// in the omnivore demo and paywalled as an essay in the reader demo), which is
// the thing the product actually does and the thing a repeated card cannot show.
//
// AND IT IS A FRONT PAGE, NOT A PARISH MAGAZINE. An earlier draft of this world
// was all harbour leases, pilot whales and hand-set type: charming, literary, and
// completely inert. Nobody clicks a canvas of council minutes, and a demo nobody
// would click is arguing against the product while appearing to agree with it.
// The subjects are now the ones a front page actually leads on — a leak, the
// money moving before the story ran, a melting timeline, a film with an enemy —
// and the spread across beats is what carries the claim that everything worth
// reading fits in one place. Keep the register: specific, consequential, and
// short of the verb. No wistfulness, no throat-clearing, no maundering.
const FEED_1: DemoCard[] = [
  {
    name: 'The Meridian',
    time: '5d',
    title: 'The Halcyon papers',
    body: 'Four shell companies, one signature, and a department that spent six months insisting the file did not exist. It does. We have it — and so does the minister who signed it…',
    photo: true,
    tag: 'via RSS · The Meridian',
  },
  {
    name: 'Halloran',
    time: '6h',
    body: 'Up nine per cent nine hours before any of us knew. Either somebody is extraordinarily lucky or somebody reads their email.',
    quote: {
      source: 'Quoting Fenwick Wire',
      text: 'Halcyon Infrastructure closed up 9.4%, its strongest session since listing — hours ahead of publication.',
    },
    tag: 'via Bluesky',
  },
  {
    name: 'Tobias Wren',
    time: '6d',
    paid: true,
    title: 'Nobody resigns in August',
    body: 'The recess is not a pause in politics. It is where politics is actually done, and this one has been used to bury three things you were meant to miss…',
    tag: 'via RSS · Third Rail',
  },
  {
    name: 'Deep Field',
    time: '1w',
    title: 'It is melting from underneath',
    body: 'The models said fifty years. The core says it started a decade ago. The team that found it spent eleven months trying to prove themselves wrong…',
    tag: 'via RSS · Deep Field',
  },
]

// Feed 2 runs at HEADLINE density, so these carry titles and no bodies: a
// standfirst written here would simply never render, and leaving one in would
// invite someone to "fix" the density later by showing it. They also have to
// work with nothing under them, which is the discipline of a real headline —
// a fact and a stake, no scene-setting.
const FEED_2: DemoCard[] = [
  { name: 'The Meridian', time: '1h', title: 'The signature, the seat, and the ninety days between', tag: 'via RSS' },
  { name: 'Fenwick Wire', time: '2h', title: 'The market moved nine hours before the story did', tag: 'via RSS' },
  { name: 'Deep Field', time: '3h', title: 'One drill core just deleted forty years from the forecast', tag: 'via RSS' },
  { name: 'Nightshift', time: '5h', title: 'The year’s biggest film has no idea what it is about', tag: 'via Nostr' },
  { name: 'Touchline', time: '6h', title: 'Three positive tests, and a lab that shut on the Friday', tag: 'via RSS' },
  { name: 'The Meridian', time: '8h', title: 'Nine years, £4bn, and a bridge that cannot take a lorry', tag: 'via RSS' },
  { name: 'Third Rail', time: '11h', title: 'The quiet, serious case for letting the lights go out', tag: 'via Nostr' },
]

const FEED_3: DemoCard[] = [
  { name: 'Halloran', time: '1h', body: 'All four shells are registered to the same address above a dry cleaner’s. They did not even pretend.', tag: 'via Bluesky' },
  { name: 'Aurelio Frame', time: '7h', body: 'The blackout maps are being drawn by people with no power, on phones with no signal, and they are better than the official ones.', tag: 'via Nostr' },
  { name: 'Ines Bergqvist', time: '9h', body: 'Nine years to build a bridge that cannot take a lorry. I know people who have had entire children faster, with better paperwork.', tag: 'via Bluesky' },
  { name: 'Halloran', time: '1d', body: 'Someone has put a mural on the substation overnight: the minister, four company names, and “90 DAYS”. Nobody will admit to it.', tag: 'via Nostr' },
  { name: 'Aurelio Frame', time: '1d', body: 'Two years of asking, and the department published the survey at half past four on a Friday. It is always half past four on a Friday.', tag: 'via Nostr' },
  { name: 'Marguerite Oyelaran', time: '2d', body: 'Three hundred people queued in the rain for a film no distributor will touch. Second screening Friday. Bring someone who disagrees with you.', tag: 'via Bluesky' },
]

const FEED_4: DemoCard[] = [
  { name: 'Rosalind Vane', time: '5d', title: 'How to read a leak', body: 'Every cache has a shape, and the shape tells you who wanted you to have it…', tag: 'via RSS' },
  { name: 'Ellis Marchetti', time: '6d', paid: true, title: 'The attention we sold', body: 'We handed over the whole thing for free, and this is the inventory of what they built with it…', tag: 'via RSS' },
  { name: 'Marguerite Oyelaran', time: '6d', title: 'The film they tried to bury', body: 'No distributor, no stars, no running time anyone will book. Also the best thing this year…', tag: 'via RSS' },
  { name: 'Tobias Wren', time: '1w', title: 'The emergency that never ended', body: 'Every temporary power in this country was introduced for six months. Not one has been given back…', tag: 'via RSS' },
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
