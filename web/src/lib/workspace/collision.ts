import { GRID, VESSEL_MIN_W, VESSEL_MIN_H } from "./grid";

// Vessels never come to REST overlapping (WORKSPACE-DESIGN-SPEC.md › Addendum
// — No-overlap governs the resting state). Since 2026-07-21 the invariant is
// enforced MOVER-YIELDS: the vessel the user is acting on finds its own clear
// spot, and the vessels it lands near NEVER move. This replaces the push-wave
// resolver (displace-what-you-hit, propagate in waves), whose third-party
// displacement — feeds bouncing aside as another was put down — was the
// glitch, and whose livelock/verify-repair machinery existed only to make the
// wave safe.
//
// Two rules do the work:
//
//   1. OBSTACLES ARE IMMOVABLE. A gesture moves exactly the vessel under the
//      user's hand. Nothing else on the floor ever changes position, so a
//      drop can never surprise the user at a distance.
//   2. HORIZONTAL IS THE ESCAPE VALVE. y is bounded by the viewport, x is
//      not; at the mover's own y there is always clear ground past the
//      furthest right edge. Only the unbounded axis can guarantee placement,
//      and "no overlap in any scenario" requires that placement always
//      succeed.
//
// Resize keeps the same contract from the other side: a stretch is CLAMPED at
// the first neighbour it would hit (clampSizeClear), so a resize commit never
// needs to move anything — including the resized vessel itself, whose anchor
// edge the user placed deliberately.
//
// Snapping is directional — ceil when escaping right/down, floor when
// escaping left/up — so a resting position is on the lattice AND provably
// clear of the obstacle it was derived from. Rounding to nearest would let a
// candidate settle back inside by up to half a cell.

export interface VesselRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function intersects(a: VesselRect, b: VesselRect): boolean {
  return !(
    a.x >= b.x + b.w ||
    a.x + a.w <= b.x ||
    a.y >= b.y + b.h ||
    a.y + a.h <= b.y
  );
}

const snapUp = (v: number) => Math.ceil(v / GRID) * GRID;
const snapDown = (v: number) => Math.floor(v / GRID) * GRID;
const snapNearest = (v: number) => Math.round(v / GRID) * GRID;

/**
 * Where the mover comes to rest: the clear, lattice-aligned, in-bounds
 * position nearest to where the user let go. Obstacles are never displaced —
 * if the requested spot is occupied, the MOVER slides to the closest spot
 * that isn't.
 *
 * Candidate positions combine the requested coordinate with coordinates
 * derived from obstacle edges (the standard slide-until-blocked argument: an
 * optimal clear position can always be translated axis-wise toward the
 * request until each axis either reaches it or touches an edge). x may be
 * negative — store coordinates are signed and the canvas extent grows to
 * cover them; bounding x would pin vessels to the viewport edge, the exact
 * limit the infinite floor removes.
 *
 * `floorBounds` carries the vertical bound only. The requested y is clamped
 * into it, so the result is in-bounds even if the caller's y is not.
 */
export function findRestingPosition(
  mover: VesselRect,
  obstacles: VesselRect[],
  floorBounds?: { h: number },
): { x: number; y: number } {
  const { w, h } = mover;
  const maxY = floorBounds ? Math.max(0, snapDown(floorBounds.h - h)) : null;
  const clampY = (y: number) =>
    maxY === null ? Math.max(0, y) : Math.max(0, Math.min(y, maxY));
  const inBoundsY = (y: number) => y >= 0 && (maxY === null || y <= maxY);

  const home = { x: snapNearest(mover.x), y: clampY(snapNearest(mover.y)) };
  const rel = obstacles.filter((o) => o.id !== mover.id);
  const clearAt = (x: number, y: number) =>
    rel.every((o) => !intersects({ id: mover.id, x, y, w, h }, o));

  if (clearAt(home.x, home.y)) return home;

  const xs = new Set<number>([home.x]);
  const ys = new Set<number>([home.y]);
  for (const o of rel) {
    xs.add(snapUp(o.x + o.w));
    xs.add(snapDown(o.x - w));
    const above = snapDown(o.y - h);
    const below = snapUp(o.y + o.h);
    if (inBoundsY(above)) ys.add(above);
    if (inBoundsY(below)) ys.add(below);
  }

  let best: { x: number; y: number } | null = null;
  let bestCost = Infinity;
  for (const y of ys) {
    for (const x of xs) {
      const cost = (x - home.x) ** 2 + (y - home.y) ** 2;
      if (cost >= bestCost) continue;
      if (!clearAt(x, y)) continue;
      best = { x, y };
      bestCost = cost;
    }
  }
  if (best) return best;

  // Unreachable while rel is non-empty (xs contains a column right of every
  // obstacle, ys contains home.y), but the escape valve is stated explicitly
  // rather than trusted implicitly: sideways past everything, at the user's y.
  const rightEdge = Math.max(...rel.map((o) => o.x + o.w));
  return { x: snapUp(rightEdge), y: home.y };
}

/**
 * Clamp a resize gesture so the stretched rect never enters a neighbour:
 * the handle stops at the first obstacle on the offending axis. `origin` and
 * `start` are the vessel's resting position/size (a resting state is clear by
 * invariant, so every intersecting obstacle lies beyond the start rect on at
 * least one axis and a valid cut always exists). Cuts are floored at the
 * vessel minimums; per obstacle the axis losing less of the proposal yields.
 */
export function clampSizeClear(
  origin: { x: number; y: number },
  start: { w: number; h: number },
  proposed: { w: number; h: number },
  obstacles: VesselRect[],
): { w: number; h: number } {
  let w = proposed.w;
  let h = proposed.h;
  // Each pass clears at least the obstacle it found by strictly shrinking one
  // axis, so obstacles.length passes suffice.
  for (let pass = 0; pass <= obstacles.length; pass++) {
    const rect = { id: "", x: origin.x, y: origin.y, w, h };
    const hit = obstacles.find((o) => intersects(rect, o));
    if (!hit) return { w, h };
    const wCut = snapDown(hit.x - origin.x);
    const hCut = snapDown(hit.y - origin.y);
    const wValid = wCut >= VESSEL_MIN_W && wCut < w;
    const hValid = hCut >= VESSEL_MIN_H && hCut < h;
    if (wValid && (!hValid || w - wCut <= h - hCut)) {
      w = wCut;
    } else if (hValid) {
      h = hCut;
    } else {
      // No valid cut means the start rect itself intersects — not a resting
      // state this function is specified for. Fall back to the start size,
      // which is the last size the invariant vouched for.
      return { w: start.w, h: start.h };
    }
  }
  return { w, h };
}

/**
 * Deterministic total repair: make `rects` mutually clear by SHELVING.
 * Vessels are kept in place greedily — the pinned one first, then
 * left-to-right — and any vessel that overlaps a kept one is parked past the
 * right edge of everything kept, the horizontal escape valve applied
 * wholesale. Shelved vessels advance the shelf one at a time, so the result
 * is provably clear whatever their heights.
 *
 * Sole caller: the workspace store's hydrate heal — layouts persisted by the
 * pre-2026-07-21 push-wave resolver can hold resting piles
 * (identical-coordinate stacks) that no gesture ever revisits, because the
 * user cannot drag a vessel they cannot see.
 */
export function repairRestingLayout(
  rects: VesselRect[],
  opts?: { pinned?: string },
): Map<string, { x: number; y: number }> {
  const pinnedId = opts?.pinned;
  const order = [...rects].sort((a, b) => {
    if (a.id === pinnedId) return -1;
    if (b.id === pinnedId) return 1;
    return a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1);
  });

  const kept: VesselRect[] = [];
  const shelved: VesselRect[] = [];
  for (const r of order) {
    if (r.id !== pinnedId && kept.some((k) => intersects(k, r))) {
      shelved.push(r);
    } else {
      kept.push(r);
    }
  }

  const updates = new Map<string, { x: number; y: number }>();
  if (shelved.length === 0) return updates;

  let shelfX = snapUp(Math.max(...kept.map((k) => k.x + k.w)) + GRID);
  for (const r of shelved) {
    updates.set(r.id, { x: shelfX, y: r.y });
    shelfX = snapUp(shelfX + r.w + GRID);
  }
  return updates;
}
