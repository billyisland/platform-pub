// The lattice every draggable surface snaps to: vessel position/size on the
// workspace floor, the canvas origin, and the Glasshouse pane's drag/resize.
//
// 20 → 10 (2026-07-20, finer placement) → 8 (2026-07-22). 8 restores the
// phase with the 4px design rhythm (Tailwind spacing + the 4px slab) that 10
// broke — the exact repair this comment used to anticipate — and it equals the
// vessel WALL (Vessel.tsx), so on the columnar floor a gutter between adjacent
// vessels reads as three even coloured bands: wall / buffer / wall. The grid
// is invisible; the stripes are how you feel it (WORKSPACE-COLUMN-LAYOUT-ADR
// §II.3). Still even, so panes and vessels land on whole pixels.
//
// Values persisted on the 10px lattice re-snap to 8 on the next gesture —
// invisible in practice, and it saves a two-lattice interregnum.
export const GRID = 8;

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

// Vessel size envelope + the intrinsic default width, shared by the Vessel
// component (resize clamps), the canvas extent derivation in WorkspaceView,
// and the workspace store's hydrate heal — one definition, so no module
// mirrors another's constant. A vessel with no stored height renders at
// content height, so VESSEL_MIN_H doubles as the conservative height estimate
// wherever the DOM isn't available to measure.
export const VESSEL_MIN_W = 220;
export const VESSEL_MIN_H = 200;
export const VESSEL_MAX_W = 2000;
export const VESSEL_MAX_H = 2000;
export const VESSEL_DEFAULT_W = 300;
