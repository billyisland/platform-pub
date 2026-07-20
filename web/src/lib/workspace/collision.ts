import { snap } from "./grid";

export interface VesselRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function resolveCollisions(
  mover: VesselRect,
  others: VesselRect[],
  // Only the vertical bound exists: the floor extends infinitely to the sides,
  // so a pushed vessel may be displaced to any x (including negative) and the
  // canvas extent grows to cover it. Bounding x here would pin vessels against
  // the viewport edge forever.
  floorBounds?: { h: number },
): Map<string, { x: number; y: number }> {
  const updates = new Map<string, { x: number; y: number }>();
  const live = new Map<string, VesselRect>();
  for (const r of others) live.set(r.id, { ...r });

  const queue: VesselRect[] = [mover];
  const visited = new Set<string>([mover.id]);
  let iters = 0;

  while (queue.length > 0 && iters < 30) {
    const pusher = queue.shift()!;
    iters++;

    for (const [id, other] of live) {
      if (id === pusher.id) continue;
      if (
        pusher.x >= other.x + other.w ||
        pusher.x + pusher.w <= other.x ||
        pusher.y >= other.y + other.h ||
        pusher.y + pusher.h <= other.y
      )
        continue;

      const fromLeft = pusher.x + pusher.w - other.x;
      const fromRight = other.x + other.w - pusher.x;
      const fromTop = pusher.y + pusher.h - other.y;
      const fromBottom = other.y + other.h - pusher.y;
      const min = Math.min(fromLeft, fromRight, fromTop, fromBottom);

      let nx = other.x;
      let ny = other.y;
      if (min === fromLeft) nx = pusher.x + pusher.w;
      else if (min === fromRight) nx = pusher.x - other.w;
      else if (min === fromTop) ny = pusher.y + pusher.h;
      else ny = pusher.y - other.h;

      if (floorBounds) {
        ny = Math.max(0, Math.min(floorBounds.h - other.h, ny));
      }

      nx = snap(nx);
      ny = snap(ny);

      if (nx !== other.x || ny !== other.y) {
        const pushed = { ...other, x: nx, y: ny };
        live.set(id, pushed);
        updates.set(id, { x: nx, y: ny });
        if (!visited.has(id)) {
          visited.add(id);
          queue.push(pushed);
        }
      }
    }
  }

  return updates;
}
