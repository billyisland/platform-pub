"use client";

// =============================================================================
// NavRow — the fixed desktop nav row (WORKSPACE-COLUMN-LAYOUT-ADR §VI).
//
// The ∀ site-navigation control left its floating disc position; it now sits in
// an ordinary opaque row along the bottom of the viewport. This component is the
// row's CHROME ONLY — the bar, its ground, and the 4px slab on its top edge. The
// lockup itself (wordmark + ∀ disc, adjacent, at the row's right end) is
// rendered by `ForallMenu anchor="row"` at z-60, exactly as the mobile bar docks
// the disc via anchor="bar". Keeping the pair in one fixed container is what
// preserves FORALL-CUT-AND-LOCKUP-ADR §V's lockup ratio and the wordmark's role
// as part of the trigger, while still killing the separate fixed wordmark layer
// the difference lens used to need.
//
// GLOBAL CHROME, NOT A FEED ISLAND: the ground is `var(--ah-bone)` and the slab
// `var(--ah-ink)` — both neutral slugs, so the row inverts with `html.dark`
// rather than carrying a per-feed colourway. Same treatment as the mobile bar.
//
// Z-ORDER: z-58, mirroring the mobile bar — above the Glasshouse scrim (z-55)
// and pane (z-56) so navigation stays live over any open pane (destination
// hopping, Explain launchable over a pane), below the ∀ disc (z-60) and the
// lightbox (z-70). Glasshouse panes inset above it (`usePanePlacement` subtracts
// NAV_ROW_H on the desktop path, the mirror of its mobile MOBILE_BAR_H branch).
//
// The floor never reaches behind it: `deriveGeometry` takes `navRowH` and ends
// the available height one GRID above the row (§III.2).
// =============================================================================

/** Row height in px. Fed to `deriveGeometry` as `navRowH` and subtracted from
 *  the Glasshouse desktop placement. 56 leaves exactly one GRID (8px) of
 *  clearance above and below the row's 40px disc. */
export const NAV_ROW_H = 56;

export function NavRow() {
  return (
    <div
      aria-hidden="true"
      // Explain chrome: the row sits above the floor-mode Explain scrim (z-50),
      // so it is never dimmed and its pointer events never reach the scrim's
      // hit-test. Marking it chrome keeps the annotation walk and the focus
      // guard from treating it as an annotatable surface.
      data-explain-chrome=""
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        height: NAV_ROW_H,
        background: "var(--ah-bone)",
        zIndex: 58,
      }}
    >
      {/* The one divider in the workspace shell — the canonical 4px slab. It is
          what makes the row read against the bone floor, which is the same
          colour; nothing thinner is permitted anywhere on the site. */}
      <div className="slab-rule-4" />
    </div>
  );
}
