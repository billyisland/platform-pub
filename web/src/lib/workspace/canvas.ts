import { snap } from "./grid";

// The workspace floor extends infinitely to the sides. Horizontal extent is
// DERIVED from the vessels that sit on it — never stored — so dragging a feed
// outward stretches the space and dragging it back contracts it again, with no
// stale empty region to clean up and nothing new to persist. Vertical extent is
// locked to the viewport: the floor can be made wider, never taller.
//
// Store coordinates are SIGNED and have no origin — a vessel may sit at a
// negative x. Native horizontal scroll has no negative offset, so the canvas
// carries an `originX`: the store-x that maps to canvas-x 0. Everything above
// the render boundary (collision, merge hit-testing, persistence) stays in
// store space; only the Vessel's `position` prop and the coordinates it hands
// back are canvas space. WorkspaceView converts at that seam and nowhere else.

/** Breathing room beyond the outermost vessel when the floor is at rest. */
export const EDGE_PAD = 40;

export interface CanvasExtent {
  /** Store-x that maps to canvas-x 0. Shifts left as the floor grows leftward. */
  originX: number;
  /** Canvas width in px; never narrower than the viewport. */
  width: number;
}

export interface ExtentRect {
  x: number;
  w: number;
}

/**
 * Derive the canvas extent from the vessels on it.
 *
 * `slack` is the room left beyond the outermost vessel on each side. At rest
 * that is EDGE_PAD (contract-to-fit). During a drag the caller widens it to a
 * viewport, so there is somewhere to drag INTO without the origin having to
 * move mid-gesture — an origin shift displaces every other vessel and has to be
 * compensated with a scroll adjustment, which is fine at a gesture boundary and
 * jittery every frame.
 *
 * `originX` is snapped so canvas coordinates stay on the 20px lattice (store
 * coordinates are already snapped, and lattice-aligned DOM positions are what
 * keep the vessels free of sub-pixel blur).
 */
export function computeExtent(
  rects: ExtentRect[],
  viewportWidth: number,
  slack: number = EDGE_PAD,
): CanvasExtent {
  if (rects.length === 0) return { originX: 0, width: viewportWidth };

  let minX = Infinity;
  let maxRight = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.x + r.w > maxRight) maxRight = r.x + r.w;
  }

  const pad = snap(slack);
  const originX = snap(minX - pad);
  return {
    originX,
    width: Math.max(viewportWidth, maxRight + pad - originX),
  };
}
