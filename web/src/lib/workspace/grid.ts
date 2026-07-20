// The lattice every draggable surface snaps to: vessel position/size on the
// workspace floor, the canvas origin, and the Glasshouse pane's drag/resize.
//
// Halved from 20px to 10px (2026-07-20) for finer placement. 10 is still even,
// so panes and vessels keep landing on whole pixels — the sub-pixel blur a
// free-positioned odd-width pane would show is still ruled out. What it gives
// up is the old 20 = LCM(10, 4) property: the lattice no longer falls in phase
// with the 4px design rhythm (Tailwind spacing + the 4px slab), so chrome and
// content no longer share every gridline. 8px would be the nearest value that
// preserves that phase, if the drift ever shows.
export const GRID = 10;

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}
