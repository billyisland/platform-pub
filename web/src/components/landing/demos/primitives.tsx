import type { CSSProperties, ReactNode } from 'react'
import type { VesselPalette } from '../../workspace/tokens'

// =============================================================================
// Landing demo primitives — the card grammar, rebuilt as inert markup.
//
// WHY THESE EXIST RATHER THAN REUSING PostCard. PostCard is the ONE card and it
// should stay that way, but it takes a `Post`, resolves a level spec, threads
// interactions, hover cards, resonance, explain tags and eight callbacks. None
// of that means anything to a logged-out visitor and all of it is weight on the
// one page a stranger loads cold. What the landing page needs is the card's
// LOOK — byline, title, body, origin tag, quote embed — with nothing behind it.
// So these are deliberately dumb: props in, markup out, no hooks, no stores, no
// client boundary of their own.
//
// THEY ARE A COPY, AND COPIES DRIFT. If the real card's byline idiom or origin
// tag changes, this will not follow it automatically. That is the accepted cost
// of not dragging the whole post stack onto `/`. The mitigation is that the
// pieces are small enough to re-read against the originals in a minute:
// Byline.tsx (byline row), PostOriginTag.tsx (the VIA line), QuotedEmbed.tsx.
//
// EVERYTHING SIZES IN `em`. Each demo's root sets one `fontSize` in px and every
// measurement below is relative to it, so a demo's whole register — type, pad,
// gaps, rules — moves with one number. Nothing here sets a font-size on an
// element that contains another font-sized element, so the ems never compound.
// =============================================================================

/** The ⊔ a demo feed sits in. Walls come from the palette being demonstrated. */
export function DemoVessel({
  palette,
  wall = 8,
  gap = 8,
  pad = 8,
  children,
  className,
  style,
}: {
  palette: VesselPalette
  /** Wall thickness in px. The workspace demo runs thinner walls at its scale. */
  wall?: number
  gap?: number
  pad?: number
  children: ReactNode
  /** For §1d geometry the stylesheet owns (the workspace demo's columns). */
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={className}
      style={{
        background: palette.interior,
        borderLeft: `${wall}px solid ${palette.walls}`,
        borderRight: `${wall}px solid ${palette.walls}`,
        borderBottom: `${wall}px solid ${palette.walls}`,
        padding: pad,
        display: 'flex',
        flexDirection: 'column',
        gap,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** One card on the vessel floor. */
export function DemoPost({
  palette,
  children,
  padding = '0.85em 1em',
}: {
  palette: VesselPalette
  children: ReactNode
  padding?: string
}) {
  return <div style={{ background: palette.cardBg, padding }}>{children}</div>
}

/**
 * The byline row — pip · name · time. Mirrors workspace/Byline.tsx's treatment
 * (mono, meta-coloured, name in cardTitle at medium weight) without its links,
 * hover modal or relative-time formatting: the times here are strings, because
 * a demo that ages ("6H" becoming "4D" after a week) would just look neglected.
 */
export function DemoByline({
  palette,
  name,
  time,
  paid,
}: {
  palette: VesselPalette
  name: string
  time: string
  /** Crimson pip — the demo's one hint that a card can carry a price. */
  paid?: boolean
}) {
  return (
    <div
      className="font-mono"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6em',
        marginBottom: '0.6em',
        color: palette.cardMeta,
        fontSize: '0.75em',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '0.5em',
          height: '0.5em',
          borderRadius: '50%',
          background: paid ? palette.crimson : palette.cardMeta,
          flex: 'none',
        }}
      />
      <span style={{ color: palette.cardTitle, fontWeight: 500 }}>{name}</span>
      <span aria-hidden="true">·</span>
      <span>{time}</span>
    </div>
  )
}

export function DemoTitle({
  palette,
  children,
}: {
  palette: VesselPalette
  children: ReactNode
}) {
  return (
    <div
      className="font-serif"
      style={{
        fontSize: '1.1em',
        lineHeight: 1.25,
        fontWeight: 600,
        color: palette.cardTitle,
        marginBottom: '0.25em',
      }}
    >
      {children}
    </div>
  )
}

export function DemoBody({
  palette,
  children,
}: {
  palette: VesselPalette
  children: ReactNode
}) {
  return (
    <div
      className="font-serif"
      style={{ fontSize: '1em', lineHeight: 1.5, color: palette.cardStandfirst }}
    >
      {children}
    </div>
  )
}

/**
 * The provenance line. The whole omnivore argument is carried by these four
 * words, so this is the one thing in the demos that must stay crisp — it is why
 * the shots were replaced. Rendered as plain text, not a button: there is
 * nowhere for a demo to link to.
 */
export function DemoTag({
  palette,
  children,
}: {
  palette: VesselPalette
  children: ReactNode
}) {
  return (
    <div
      className="font-mono"
      style={{
        fontSize: '0.7em',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: palette.cardMeta,
        marginTop: '0.7em',
      }}
    >
      {children}
    </div>
  )
}

/** Quoted-post embed. Sits on the WALLS colour, exactly as the real one does. */
export function DemoQuote({
  palette,
  source,
  children,
}: {
  palette: VesselPalette
  source: string
  children: ReactNode
}) {
  return (
    <div
      className="font-serif"
      style={{
        background: palette.quoteBg,
        color: palette.quoteText,
        padding: '0.7em 0.85em',
        marginTop: '0.6em',
        fontSize: '0.93em',
        lineHeight: 1.45,
      }}
    >
      <span
        className="font-mono"
        style={{
          display: 'block',
          color: palette.quoteMeta,
          fontSize: '0.68em',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: '0.6em',
        }}
      >
        {source}
      </span>
      {children}
    </div>
  )
}
