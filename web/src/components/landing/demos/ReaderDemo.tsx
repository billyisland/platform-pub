import { paletteFor, type VesselPalette } from '../../workspace/tokens'
import { DemoVessel, DemoPost, DemoByline, DemoTitle, DemoBody, DemoTag } from './primitives'

// =============================================================================
// ReaderDemo — the reading pane ON THE GLASSHOUSE. Supersedes GateDemo.
//
// WHAT WAS WRONG WITH THE BARE GATE. Shown on plain card ground it read as
// TEXT THAT HAD GONE WRONG — a paragraph trailing off into a fade, then a price,
// then two buttons, floating on nothing. Every part of the visual grammar that
// makes a paywall legible as a paywall was missing, because that grammar is not
// in the gate: it is in the SITUATION the gate appears in. A reader recognises a
// paywall by the shape of a pane held over an interrupted background, and there
// was no background and no pane.
//
// So the demo now shows the whole Glasshouse figure, which is the canonical
// "surface opened over the workspace" primitive:
//
//   FLOOR — four feed vessels in four colourways, blurred and desaturated. This
//           does double duty: it supplies the interrupted background the gate
//           needs, and it quietly restates the canvas argument from the demo
//           above, so a visitor sees the reader as something that opens OVER
//           their feeds rather than as a separate place they navigate to.
//   SCRIM — bone-bright at 0.72 (ink-925 at 0.74 in dark), matching `.gh-scrim`.
//   PANE  — glasshouse ground, lifted by an elevation shadow ALONE with no top
//           edge, per GLASSHOUSE-AND-PALETTE-ADR §III.2, carrying the drag grip
//           and the ✕. Inside it: the article, then the gate.
//
// THE BLUR IS A `filter` ON THE FLOOR, NOT `backdrop-filter` ON THE SCRIM. The
// real `.gh-scrim` uses backdrop-filter because it sits over a live, scrolling
// workspace it cannot know the contents of. Here the floor is inert markup that
// exists only to be blurred, so blurring it directly is cheaper, avoids the
// backdrop-filter containment bugs that bite inside transformed or clipped
// ancestors, and renders identically. Do NOT "correct" this to backdrop-filter
// for consistency with the real scrim — the situations are not the same.
//
// THE PANE'S MARGIN REPLACES THE OLD `INSET`. The previous version pulled the
// gate in from the card edge so it would read as a specimen rather than as the
// page's own prose. That signal is now carried structurally: a lifted pane over
// a blurred field cannot be mistaken for the page's content, so the inset is no
// longer doing separate work — it is just the pane's margin, which is what it
// looked like it was all along.
//
// SIZING, unchanged in principle: one base font-size on the root, everything
// inside in `em`, so the whole figure moves as a unit. It stays a clear step
// below the page's 17px prose, because the article text inside the pane is
// filler and a visitor who starts reading it gets nothing for it.
//
// THE BYLINES AND BODIES ON THE FLOOR ARE INVENTED — see the note in CanvasDemo,
// whose invented world this shares. It matters even here, where the floor is
// blurred to texture: blur is a rendering choice, and the names would still be
// in the markup, in the DOM, and in view of anyone who reads it.
//
// WHY NOT REUSE PaywallGate. It takes fifteen props about a real reader's real
// balance, fires an IntersectionObserver, POSTs a nudge-shown event, and renders
// copy branched on login state and remaining credit. Mounting that on `/` to
// show a stranger what a paywall looks like would be absurd. This is the one
// branch of its copy that states the argument — used your credit, pay per read,
// subscription as the alternative — frozen as markup.
// =============================================================================

interface FloorCard {
  name: string
  time: string
  title?: string
  body: string
  tag: string
  paid?: boolean
}

const FLOOR: { scheme: 'basic' | 'summer' | 'autumn' | 'spring'; cards: FloorCard[] }[] = [
  {
    scheme: 'basic',
    cards: [
      {
        name: 'Tobias Wren',
        time: '5d',
        title: 'A theory of power',
        body: 'There are many considerations in appointing a cabinet: rewarding loyal supporters, balancing factions, keeping rivals away…',
        tag: 'via RSS',
      },
      { name: 'Ines Bergqvist', time: '6h', body: 'The timetable change already fixed this. Ridership didn’t fall.', tag: 'via Bluesky' },
    ],
  },
  {
    scheme: 'summer',
    cards: [
      { name: 'The Meridian', time: '1h', body: 'Harbour scheme approved after a decade of objections…', tag: 'via RSS' },
      { name: 'Fenwick Wire', time: '2h', body: 'Veteran striker signs one more year at thirty-eight…', tag: 'via RSS' },
    ],
  },
  {
    scheme: 'autumn',
    cards: [
      {
        name: 'Halloran',
        time: '1h',
        body: 'Are the high-street cinemas owned by private equity now? Distinct whiff of the same slow death about them.',
        tag: 'via Bluesky',
      },
    ],
  },
  {
    scheme: 'spring',
    cards: [
      { name: 'Marguerite Oyelaran', time: '5d', paid: true, title: 'The Ravelin', body: 'The prettiest magazine I’ve reviewed so far…', tag: 'via RSS' },
    ],
  },
]

export function ReaderDemo({ palette, dark }: { palette: VesselPalette; dark: boolean }) {
  const rule = { height: 2, background: palette.crimson, margin: '1.4em 0' }

  return (
    <div className="ah-demo-reader" style={{ background: palette.interior }}>
      {/* The workspace continuing behind. aria-hidden and inert: it is texture. */}
      <div className="ah-demo-reader-floor" aria-hidden="true">
        {FLOOR.map((column) => {
          const p = paletteFor(column.scheme, dark)
          return (
            <DemoVessel key={column.scheme} palette={p}>
              {column.cards.map((card, i) => (
                <DemoPost key={i} palette={p} padding="0.75em 0.85em">
                  <DemoByline palette={p} name={card.name} time={card.time} paid={card.paid} />
                  {card.title ? <DemoTitle palette={p}>{card.title}</DemoTitle> : null}
                  <DemoBody palette={p}>{card.body}</DemoBody>
                  <DemoTag palette={p}>{card.tag}</DemoTag>
                </DemoPost>
              ))}
            </DemoVessel>
          )
        })}
      </div>

      <div className="ah-demo-reader-scrim" aria-hidden="true" />

      <div className="ah-demo-reader-pane" style={{ background: 'var(--ah-glasshouse)' }}>
        {/* The drag grip — the discoverable affordance for a pane that is
            draggable by any empty part of itself. Included because it is what
            tells a visitor this thing FLOATS. */}
        <div className="ah-demo-grip" aria-hidden="true" />
        <div className="ah-demo-close" aria-hidden="true" style={{ color: palette.cardMeta }}>
          &times;
        </div>

        <div
          className="font-serif ah-demo-art"
          style={{ color: palette.cardTitle, ['--ah-demo-pane' as string]: 'var(--ah-glasshouse)' }}
        >
          We spent most of the spring pretending the calendar was a suggestion,
          and most of the summer discovering that it was not. What follows is an
          attempt to look squarely at the white noise of activity, just to see how
          the layout of our weeks might look if we finally got our act together.
        </div>

        <div style={rule} />

        <div style={{ textAlign: 'center' }}>
          <div
            className="font-serif"
            style={{ fontSize: '1.45em', lineHeight: 1.2, fontWeight: 500, color: palette.cardTitle, marginBottom: '0.5em' }}
          >
            Keep reading
          </div>
          <p
            className="font-serif"
            style={{ fontSize: '0.92em', lineHeight: 1.5, color: palette.cardStandfirst, maxWidth: '26em', margin: '0 auto 1.3em' }}
          >
            You&rsquo;ve used your free reading credit. Add a payment card to keep
            reading &mdash; you only pay for what you read.
          </p>
          <div
            className="font-serif"
            style={{ fontSize: '2.1em', lineHeight: 1, color: palette.cardTitle, marginBottom: '0.6em' }}
          >
            &pound;0.40
          </div>

          {/* Inert. See the note in LandingFigure: the demos are aria-hidden
              reconstructions, so these are divs, not buttons — a control that
              does nothing is worse than no control. */}
          <div
            aria-hidden="true"
            style={{ display: 'inline-block', background: palette.crimson, color: 'var(--ah-white)', padding: '0.85em 2em', fontSize: '1em', lineHeight: 1 }}
          >
            Continue reading
          </div>
          <div aria-hidden="true" style={{ fontSize: '0.95em', color: palette.cardTitle, marginTop: '1em' }}>
            Add a payment card &rarr;
          </div>

          {/* The subscription alternative is separated by its own room, not by a
              rule. This bundle, like the one before it, drew a one-pixel divider
              here — which the house never renders, and which only the tripwire's
              bare-`1` pattern catches, since a numeric style value picks up its
              unit at render. Whitespace does the same work and is the sitewide
              answer. */}
          <div style={{ fontSize: '0.92em', color: palette.cardStandfirst, margin: '3em 0 1em' }}>
            Or subscribe to The Slow Hour for{' '}
            <strong style={{ fontWeight: 500 }}>&pound;5.00/mo</strong> to read everything
          </div>
          <div
            aria-hidden="true"
            style={{ display: 'inline-block', background: palette.cardTitle, color: 'var(--ah-glasshouse)', padding: '0.8em 1.9em', fontSize: '0.95em', lineHeight: 1 }}
          >
            Subscribe
          </div>
        </div>

        <div style={rule} />
      </div>
    </div>
  )
}
