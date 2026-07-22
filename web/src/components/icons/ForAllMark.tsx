interface ForAllMarkProps {
  size?: number
  className?: string
}

/**
 * ∀ — the universal quantifier, rendered as an inverted capital A.
 * Canonical construction (docs/adr/LOGO-REFINEMENT-SPEC.md): stroked legs
 * meeting in a mitred interior apex, straight crossbar in the upper third,
 * slightly lighter than the legs. This mark defines the canonical stance
 * (~20.5° leg splay); the disc marks (ForallMenu trigger, favicon) derive
 * from it. `size` is the rendered HEIGHT; width follows the 0.7 aspect.
 *
 * The DISC form additionally has a canonical CUT realisation — the ∀ punched
 * clean through an opaque disc, apex kissing the bottom rim, feet running out
 * flush through the top (docs/adr/FORALL-CUT-AND-LOCKUP-ADR §III; exported
 * assets in web/public/brand/ — the one ground that is ours to show. The
 * workspace disc paints rather than punches: its idle difference lens went
 * with the floating position, WORKSPACE-COLUMN-LAYOUT-ADR §VI).
 * That geometry is the cut form's only — this bare glyph has no rim to kiss
 * and is unchanged by it.
 */
export function ForAllMark({ size = 22, className = '' }: ForAllMarkProps) {
  const h = size
  const w = Math.round(size * 0.7)

  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 112 160"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {/* Legs: one path so the interior apex miter-joins — two separate lines
          with butt caps would notch at the apex. The butt-cap corners overhang
          the viewBox on three sides and the default overflow clipping crops
          them to a flat top edge — intended; don't shrink the path or make
          overflow visible. */}
      <path
        d="M6 0 L56 134 L106 0"
        stroke="currentColor"
        strokeWidth={15}
        strokeLinejoin="miter"
        strokeMiterlimit={6}
      />
      {/* Crossbar: upper third, ~84% of the leg weight */}
      <rect x="20" y="44.75" width="72" height="12.5" fill="currentColor" />
    </svg>
  )
}
