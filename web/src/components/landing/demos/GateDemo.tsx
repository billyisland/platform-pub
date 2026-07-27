import type { VesselPalette } from '../../workspace/tokens'

// =============================================================================
// GateDemo — the paywall gate, shown as a SPECIMEN.
//
// THE SIZING IS THE WHOLE POINT OF THIS FILE, so it gets the long comment.
//
// The screenshot this replaces had a second problem beyond legibility: what
// survived the downscale was set at roughly the page's own reading size. The
// gate's prose landed at ~16px directly beneath the landing page's own 17px
// prose card, so the eye could not tell which paragraph was the page talking
// and which was the product being demonstrated. A visitor started READING the
// specimen — and it is filler, so they got nothing for it and lost the thread of
// the argument. Worse, the price sat at ~38px, larger than anything on the page
// but the headline: a £0.75 shouting over "No one should own the public square."
//
// TWO SIGNALS FIX IT, and both are needed.
//
//   1. REGISTER. Base 13px, a clear step below the page's 17px prose. Small
//      enough that the specimen is scanned rather than read, large enough that
//      "Keep reading", the price and the two buttons stay unambiguous — which is
//      all the demo has to convey. The price is 2.1em (~27px): still the anchor
//      WITHIN the specimen, no longer competing with the page's own voice.
//
//   2. INSET. The gate is pulled in from the card's edges (INSET below) so it
//      sits as an object ON the card rather than filling it. Small type alone
//      says "specimen"; small type plus margin says it without ambiguity. This
//      is the one demo that gets the inset, because it is the only one that
//      could otherwise be mistaken for the page's own content — the other two
//      are self-evidently pictures of an app.
//
// ONE KNOB. Everything below is `em` off the root's `fontSize`, including pad,
// gaps and the crimson rules, so the whole specimen contracts as a unit and the
// small type never swims in spacing tuned for larger type. Change BASE and the
// demo re-proportions itself; nothing here is a hand-tuned px except BASE and
// INSET. No element sets a font-size inside another font-sized element, so the
// ems do not compound.
//
// WHY NOT REUSE PaywallGate. It takes fifteen props about a real reader's real
// balance, fires an IntersectionObserver, POSTs a nudge-shown event, and renders
// copy branched on login state and remaining credit. Mounting that on `/` to
// show a stranger what a paywall looks like would be absurd. This is the one
// branch of its copy that states the argument — used your credit, pay per read,
// subscription as the alternative — frozen as markup.
// =============================================================================

// BASE and INSET are declared in globals.css §1d as `--ah-demo-gate-base` and
// `--ah-demo-gate-inset` (13px / 52px on desktop, 12px / 0 on mobile, where a
// 358px vessel cannot spare 104px to make a point about margin). They are NOT
// constants here because `/` is server-rendered: a JS breakpoint would paint the
// desktop inset on a phone and snap after hydration, the same trap §1c calls
// out. The fallbacks below are the desktop values, so the demo still renders
// correctly if the stylesheet is ever loaded without §1d.

export function GateDemo({ palette }: { palette: VesselPalette }) {
  const rule = {
    height: 2,
    background: palette.crimson,
    margin: '1.5em 0',
  }

  return (
    <div
      className="ah-demo-gate"
      style={{ background: palette.cardBg }}
    >
      {/* The article being interrupted. Fades under a gradient to the card
          ground, exactly as the real gate does — at this size it reads as
          texture, which is correct: it is scene-setting, not copy. */}
      <div
        className="font-serif"
        style={{
          position: 'relative',
          fontSize: '1em',
          lineHeight: 1.6,
          color: palette.cardTitle,
          paddingBottom: '1.2em',
        }}
      >
        We spent most of the spring pretending the calendar was a suggestion, and
        most of the summer discovering that it was not. What follows is an
        attempt to look squarely at the white noise of activity, just to see how
        the layout of our weeks might look if we finally got our act together.
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '3.4em',
            background: `linear-gradient(to bottom, transparent, ${palette.cardBg})`,
          }}
        />
      </div>

      <div style={rule} />

      <div style={{ textAlign: 'center' }}>
        <div
          className="font-serif"
          style={{
            fontSize: '1.45em',
            lineHeight: 1.2,
            fontWeight: 500,
            color: palette.cardTitle,
            marginBottom: '0.5em',
          }}
        >
          Keep reading
        </div>
        <p
          className="font-serif"
          style={{
            fontSize: '0.92em',
            lineHeight: 1.5,
            color: palette.cardStandfirst,
            maxWidth: '30em',
            margin: '0 auto 1.5em',
          }}
        >
          You&rsquo;ve used your free reading credit. Add a payment card to keep
          reading &mdash; you only pay for what you read.
        </p>

        <div
          className="font-serif"
          style={{
            fontSize: '2.1em',
            lineHeight: 1,
            color: palette.cardTitle,
            marginBottom: '0.6em',
          }}
        >
          &pound;0.75
        </div>

        {/* Inert. A demo button that did nothing on click would be a small lie;
            one that navigated would be a bigger one, since there is no article
            behind it. Rendered as a div with no role, so assistive tech doesn't
            announce a control — the figure's caption carries the meaning. */}
        <div
          aria-hidden="true"
          style={{
            display: 'inline-block',
            background: palette.crimson,
            color: 'var(--ah-white)',
            padding: '0.85em 2em',
            fontSize: '1em',
            lineHeight: 1,
          }}
        >
          Continue reading
        </div>

        <div
          aria-hidden="true"
          style={{
            fontSize: '0.95em',
            color: palette.cardTitle,
            marginTop: '1.1em',
          }}
        >
          Add a payment card &rarr;
        </div>

        {/* The subscription alternative is separated by its own room, not by a
            rule. The bundle this arrived in drew a one-pixel divider here,
            which the house never renders — and which the tripwire missed, as a
            bare `1` in a style object only picks up its unit at render.
            Whitespace does the same work and is the sitewide answer. */}
        <div
          style={{
            fontSize: '0.92em',
            color: palette.cardStandfirst,
            margin: '3.2em 0 1em',
          }}
        >
          Or subscribe to The Slow Hour for{' '}
          <strong style={{ fontWeight: 500 }}>&pound;5.00/mo</strong> to read
          everything
        </div>

        <div
          aria-hidden="true"
          style={{
            display: 'inline-block',
            background: palette.cardTitle,
            color: palette.cardBg,
            padding: '0.8em 1.9em',
            fontSize: '0.95em',
            lineHeight: 1,
          }}
        >
          Subscribe
        </div>
      </div>

      <div style={rule} />
    </div>
  )
}
