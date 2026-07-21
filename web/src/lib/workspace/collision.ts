import { GRID } from "./grid";

// Vessels never come to REST overlapping (WORKSPACE-DESIGN-SPEC.md › Addendum
// — No-overlap governs the resting state). This resolver is what enforces
// that: given the vessel the user is holding, it displaces everything it
// intersects until the layout is clear.
//
// Three rules do the work, all load-bearing:
//
//   1. The MOVER IS IMMOVABLE and is itself an obstacle. It is the thing under
//      the user's hand, so it never yields — and no chain push may land a
//      vessel back underneath it (the old resolver seeded the queue with the
//      mover but left it out of the obstacle set, so nothing was ever tested
//      against it after the first pass).
//   2. HORIZONTAL IS THE ESCAPE VALVE. y is bounded by the viewport, x is not.
//      A vertical push that would clamp against the floor is not available:
//      the resolver goes sideways instead of accepting the overlap. Only the
//      unbounded axis can guarantee resolution, and "no overlap in any
//      scenario" requires that resolution always succeed.
//   3. RELAXATION TO A FIXED POINT, not a single pass. A vessel displaced a
//      second time must propagate that displacement (the old `visited` guard
//      enqueued each vessel as a pusher only once, which is how a nudge into a
//      packed row left two vessels stacked at the same coordinate).
//
// Snapping is directional — ceil when pushing right/down, floor when pushing
// left/up — so a resting position is on the lattice AND provably clear of the
// obstacle. Rounding to nearest would let a push settle back inside by up to
// half a cell.

export interface VesselRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Propagation budget — the number of vessels popped as pushers, not the number
 * of pushes. Feeds number in the tens and a wave visits each a handful of
 * times; this is a runaway backstop, not an expected limit.
 */
const MAX_OPS = 400;

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

interface Candidate {
  x: number;
  y: number;
  /** Displacement distance — the resolver prefers the cheapest move. */
  cost: number;
}

/**
 * The four ways `target` can leave `obstacle`, each snapped clear of it.
 * Ordered right, left, down, up so ties break outward along the unbounded
 * axis rather than into the bounded one.
 */
function candidates(target: VesselRect, obstacle: VesselRect): Candidate[] {
  return [
    {
      x: snapUp(obstacle.x + obstacle.w),
      y: target.y,
      cost: obstacle.x + obstacle.w - target.x,
    },
    {
      x: snapDown(obstacle.x - target.w),
      y: target.y,
      cost: target.x + target.w - obstacle.x,
    },
    {
      x: target.x,
      y: snapUp(obstacle.y + obstacle.h),
      cost: obstacle.y + obstacle.h - target.y,
    },
    {
      x: target.x,
      y: snapDown(obstacle.y - target.h),
      cost: target.y + target.h - obstacle.y,
    },
  ];
}

/**
 * Displace `target` clear of `obstacle`, choosing the cheapest move that is
 * actually available. A candidate is unavailable if it would be clamped by the
 * vertical bound (rule 2) or would park the target under the mover (rule 1).
 */
function pushClear(
  target: VesselRect,
  obstacle: VesselRect,
  mover: VesselRect,
  floorBounds?: { h: number },
): { x: number; y: number } {
  const viable = candidates(target, obstacle).filter((c) => {
    // Rule 2 — a vertical move that the floor would clamp is not a move. x is
    // unbounded, so a horizontal candidate is always geometrically available.
    if (floorBounds && c.y !== target.y) {
      if (c.y < 0 || c.y + target.h > floorBounds.h) return false;
    }
    // Rule 1 — never resolve one overlap by creating one with the mover.
    // (When the mover IS the obstacle every candidate clears it by
    // construction, so this filter is a no-op there.)
    if (obstacle.id !== mover.id) {
      if (intersects({ ...target, x: c.x, y: c.y }, mover)) return false;
    }
    return true;
  });

  // Squeezed from every side — take the unbounded axis out. The floor extends
  // sideways without limit precisely so this case has an answer.
  if (viable.length === 0) {
    return { x: snapUp(obstacle.x + obstacle.w), y: target.y };
  }

  let best = viable[0];
  for (const c of viable) if (c.cost < best.cost) best = c;
  return { x: best.x, y: best.y };
}

/**
 * Resolve every overlap the mover has caused.
 *
 * Returns the vessels that had to move, in store coordinates. The mover is
 * never among them — it is immovable by construction, so a caller can apply
 * the result without re-reading the position it is mid-gesture on.
 *
 * `floorBounds` carries the vertical bound only: the floor extends infinitely
 * to the sides, so a displaced vessel may land at any x (including negative)
 * and the canvas extent grows to cover it. Bounding x here would pin vessels
 * against the viewport edge — the exact limit the infinite floor removes.
 */
export function resolveCollisions(
  mover: VesselRect,
  others: VesselRect[],
  floorBounds?: { h: number },
): Map<string, { x: number; y: number }> {
  // Normalise onto the lattice at entry, so an axis a vessel is never pushed
  // along still comes to rest on it. Candidate positions are lattice-aligned by
  // construction (snapUp/snapDown); this covers the carried-through axis.
  const onLattice = (r: VesselRect): VesselRect => ({
    ...r,
    x: Math.round(r.x / GRID) * GRID,
    y: Math.round(r.y / GRID) * GRID,
  });

  const held = onLattice(mover);
  const live = new Map<string, VesselRect>();
  for (const r of others) {
    if (r.id === mover.id) continue;
    live.set(r.id, onLattice(r));
  }

  // Displacement propagates in WAVES out from the mover: the mover pushes what
  // it overlaps, those push what they overlap, and so on. A vessel is only ever
  // displaced by one nearer the mover in the chain, so a 40px nudge travels
  // down a row as a 40px shuffle. Resolving every pair at once instead lets a
  // vessel be shoved by a neighbour that is itself about to move out of the
  // way, which compounds into displacements far larger than the gesture.
  //
  // Unlike the previous implementation there is NO visited guard: a vessel
  // displaced a second time re-enters the queue and propagates again. That
  // guard is what left vessels stacked at identical coordinates. Termination
  // rests on the operation budget instead.
  const queue: string[] = [];
  const seed = { ...held };
  let ops = 0;

  const propagate = (pusher: VesselRect) => {
    for (const [id, other] of live) {
      if (id === pusher.id) continue;
      if (!intersects(pusher, other)) continue;
      const next = pushClear(other, pusher, held, floorBounds);
      if (next.x === other.x && next.y === other.y) continue;
      live.set(id, { ...other, x: next.x, y: next.y });
      queue.push(id);
    }
  };

  propagate(seed);
  while (queue.length > 0 && ops < MAX_OPS) {
    ops++;
    const id = queue.shift()!;
    const pusher = live.get(id);
    if (pusher) propagate(pusher);
  }

  const updates = new Map<string, { x: number; y: number }>();
  for (const original of others) {
    const settled = live.get(original.id);
    if (!settled) continue;
    if (settled.x !== original.x || settled.y !== original.y) {
      updates.set(original.id, { x: settled.x, y: settled.y });
    }
  }
  return updates;
}
