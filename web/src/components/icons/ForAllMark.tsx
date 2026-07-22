interface ForAllMarkProps {
  size?: number
  className?: string
}

/**
 * ∀ — the universal quantifier, rendered as an inverted capital A.
 * Canonical construction (docs/adr/LOGO-REFINEMENT-SPEC.md): stroked legs
 * meeting in a mitred interior apex, straight crossbar in the upper third,
 * slightly lighter than the legs. This mark is the BARE form and defines the
 * canonical stance (~20.5° leg splay). `size` is the rendered HEIGHT; width
 * follows the 0.7 aspect.
 *
 * TWO STANCES, ONE CONSTRUCTION (2026-07-22). The DISC form — the ForallMenu
 * trigger, favicon.svg, and the brand exports in web/public/brand/ — does NOT
 * derive its splay from this mark. It pins both ends to the rim (apex mitred to
 * a point kissing the bottom, feet overshooting so the disc trims them flush
 * through the top, docs/adr/FORALL-CUT-AND-LOCKUP-ADR §III.1), and that
 * constraint forces a ≈16.7° splay — narrower and taller than this one. The
 * difference is derived, not drawn: only the disc form has a rim, so only it
 * kisses, and this bare glyph is unchanged by it. Don't "reconcile" the two by
 * copying either set of numbers across (the ADR's §III.1 resolution note and
 * LOGO-REFINEMENT-SPEC's header record why).
 *
 * Realisation is separate from geometry: the disc form's CUT realisation (∀ a
 * real hole) is exports-only — the workspace disc and the favicon paint, since
 * their ground isn't ours to show. The idle difference lens went with the
 * floating position, WORKSPACE-COLUMN-LAYOUT-ADR §VI.
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
