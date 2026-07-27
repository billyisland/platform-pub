import { paletteFor, type VesselPalette } from '../../workspace/tokens'
import { DemoVessel, DemoPost, DemoByline, DemoTitle, DemoBody, DemoTag } from './primitives'

// =============================================================================
// WorkspaceDemo — three vessels side by side. The "as many as you like" claim,
// shown rather than asserted.
//
// WHAT THE SCREENSHOT COULDN'T DO. The capture it replaces held four full feeds
// in a 1848px viewport shrunk to 640px, so each column was ~160px of unreadable
// grey with long empty runs beneath the cards — it read as a wireframe of
// something, and the one genuinely distinctive thing about the workspace, that
// EACH FEED CARRIES ITS OWN WALL COLOUR, was the first casualty. Rebuilt as
// markup, three columns fit at a legible-enough scale and the walls are the
// point rather than an accident of the capture.
//
// THE WALLS ARE REAL COLOURWAYS, not invented hexes: basic, spring and winter,
// resolved through paletteFor with the same dark flag as the page. So the demo
// advertises three schemes a visitor can actually pick, and inverts correctly
// with the global toggle instead of pinning two hand-picked greens. If the
// seasonal surfaces are ever retuned this follows them.
//
// SCHEMATIC REGISTER. This is the SMALLEST of the three demos, deliberately. It
// is not asking to be read — it is asking to be recognised as "several feeds,
// each different, side by side", which survives at 12px in a way that the
// omnivore column's argument would not. Truncated card bodies are honest here:
// the real workspace clips the same way.
//
// The bottom band with the numeral stands in for VesselBar. A real bar carries a
// scheme control, a close button and an add-source field; at this scale those
// would be three grey smudges, so it carries only the numeral — which is the one
// piece of it that means anything without an account.
// =============================================================================

// BASE and the column count live in globals.css §1d (`.ah-demo-workspace`):
// 12px / three columns on desktop, 11px / two on mobile, where three columns in
// a 318px card would be ~100px each and the cards would stop reading as cards.
// The third column is hidden rather than reflowed — `n feeds side by side` is
// the claim, and two demonstrate it as well as three at half the width. CSS and
// not JS for the same SSR reason as §1c.

interface DemoCard {
  name: string
  time: string
  title?: string
  body: string
  tag: string
}

// THE BYLINES AND BODIES ARE INVENTED, and must stay that way. The captures
// these demos replaced showed real posts by real people, which is defensible in
// a screenshot and is not defensible here: retyped as markup, a named person's
// post is indistinguishable from words we put in their mouth, on a page whose
// job is to sell something. Invented names cost the demo nothing — the claim is
// "several feeds, each in its own colours", and no part of it needs a real
// byline to land. The publications are shared with OmnivoreDemo and GateDemo so
// the three demos read as one coherent invented world rather than three.
const COLUMNS: { scheme: 'basic' | 'spring' | 'winter'; numeral: number; cards: DemoCard[] }[] = [
  {
    scheme: 'basic',
    numeral: 1,
    cards: [
      { name: 'The Meridian', time: '1h', body: 'Harbour scheme approved after a decade of objections…', tag: 'via RSS' },
      { name: 'Fenwick Wire', time: '2h', body: 'Veteran striker signs one more year at thirty-eight…', tag: 'via RSS' },
      { name: 'Rosalind Vane', time: '2h', body: 'The mayor says she will disagree in public, and mean it…', tag: 'via RSS' },
    ],
  },
  {
    scheme: 'spring',
    numeral: 2,
    cards: [
      {
        name: 'Tobias Wren',
        time: '5d',
        title: 'A theory of power',
        body: 'There are many considerations in appointing a cabinet: rewarding loyalists, balancing factions…',
        tag: 'via RSS',
      },
      {
        name: 'Marguerite Oyelaran',
        time: '6d',
        title: 'Finding an agent',
        body: 'Several friends are looking for agents right now, and the same three questions keep coming up…',
        tag: 'via RSS',
      },
    ],
  },
  {
    scheme: 'winter',
    numeral: 3,
    cards: [
      {
        name: 'Halloran',
        time: '1h',
        body: 'Are the high-street cinemas owned by private equity now? Distinct whiff of the same slow death about them.',
        tag: 'via Bluesky',
      },
      {
        name: 'Pell',
        time: '1h',
        body: 'The part I actually want next is columnar storage over atproto.',
        tag: 'via Bluesky',
      },
    ],
  },
]

/** The numeral band standing in for VesselBar. Sits flush to the vessel's pad. */
function DemoBar({ palette, numeral }: { palette: VesselPalette; numeral: number }) {
  return (
    <div
      style={{
        background: palette.barBg,
        height: '1.9em',
        display: 'flex',
        alignItems: 'center',
        padding: '0 0.7em',
        margin: '0 -0.5em -0.5em',
      }}
    >
      <span
        className="font-mono"
        style={{ color: palette.barText, fontSize: '0.9em', fontWeight: 500 }}
      >
        {numeral}
      </span>
    </div>
  )
}

export function WorkspaceDemo({ dark }: { dark: boolean }) {
  return (
    <div className="ah-demo-workspace">
      {COLUMNS.map((column) => {
        const palette = paletteFor(column.scheme, dark)
        return (
          <DemoVessel
            key={column.scheme}
            palette={palette}
            // Only the numbered class is real — §1d hides the third column on
            // mobile through it. The bundle also carried a bare
            // `ah-demo-ws-col`, which no stylesheet defines; dropped rather than
            // left as a hook nothing hangs from.
            className={`ah-demo-ws-col-${column.numeral}`}
            wall={6}
            gap={6}
            pad={6}
            // The bar's negative margin is expressed in em off this demo's base;
            // `pad` is px. 6px ≈ 0.5em at base 12, which is what DemoBar assumes.
            style={{ minWidth: 0 }}
          >
            {column.cards.map((card, i) => (
              <DemoPost key={i} palette={palette} padding="0.75em 0.85em">
                <DemoByline palette={palette} name={card.name} time={card.time} />
                {card.title ? <DemoTitle palette={palette}>{card.title}</DemoTitle> : null}
                <DemoBody palette={palette}>{card.body}</DemoBody>
                <DemoTag palette={palette}>{card.tag}</DemoTag>
              </DemoPost>
            ))}
            <DemoBar palette={palette} numeral={column.numeral} />
          </DemoVessel>
        )
      })}
    </div>
  )
}
