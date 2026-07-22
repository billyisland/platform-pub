import { describe, it, expect } from "vitest";
import { GRID } from "./grid";
import {
  findRestingPosition,
  clampSizeClear,
  repairRestingLayout,
  type VesselRect,
} from "./collision";

// The invariant under test (WORKSPACE-DESIGN-SPEC.md › Addendum — No-overlap
// governs the resting state, mover-yields since 2026-07-21): the vessel the
// user is acting on comes to rest clear of everything, and NOTHING ELSE ever
// moves. Placement must always succeed, because the floor is unbounded
// sideways and horizontal is the escape valve.

function overlaps(a: VesselRect, b: VesselRect): boolean {
  return !(
    a.x >= b.x + b.w ||
    a.x + a.w <= b.x ||
    a.y >= b.y + b.h ||
    a.y + a.h <= b.y
  );
}

function expectClear(
  mover: VesselRect,
  pos: { x: number; y: number },
  obstacles: VesselRect[],
) {
  const settled = { ...mover, x: pos.x, y: pos.y };
  for (const o of obstacles) {
    expect(
      overlaps(settled, o),
      `mover at (${pos.x},${pos.y}) overlaps ${o.id} at (${o.x},${o.y})`,
    ).toBe(false);
  }
}

describe("findRestingPosition", () => {
  it("returns the requested spot when it is already clear", () => {
    const mover: VesselRect = { id: "M", x: 0, y: 104, w: 300, h: 400 };
    const others: VesselRect[] = [
      { id: "A", x: 400, y: 104, w: 300, h: 400 },
      { id: "B", x: 800, y: 104, w: 300, h: 400 },
    ];
    expect(findRestingPosition(mover, others, { h: 800 })).toEqual({
      x: 0,
      y: 104,
    });
  });

  it("slides the mover clear of a single overlapped neighbour", () => {
    const mover: VesselRect = { id: "M", x: 300, y: 104, w: 300, h: 400 };
    const others: VesselRect[] = [{ id: "A", x: 560, y: 104, w: 300, h: 400 }];
    const pos = findRestingPosition(mover, others, { h: 800 });
    expectClear(mover, pos, others);
    // The cheap escape is a small slide left, not a fling.
    expect(pos.y).toBe(104);
    expect(pos.x).toBe(256);
  });

  it("prefers the nearest clear spot over any further one", () => {
    // Overlapping A's right edge by 40px: settling right of A (x=560) costs
    // 40; every other escape costs hundreds.
    const mover: VesselRect = { id: "M", x: 520, y: 104, w: 300, h: 400 };
    const others: VesselRect[] = [{ id: "A", x: 260, y: 104, w: 300, h: 400 }];
    expect(findRestingPosition(mover, others, { h: 800 })).toEqual({
      x: 560,
      y: 104,
    });
  });

  it("never returns a position outside the vertical bound", () => {
    const mover: VesselRect = { id: "M", x: 100, y: 700, w: 300, h: 400 };
    const others: VesselRect[] = [{ id: "A", x: 100, y: 0, w: 300, h: 380 }];
    const pos = findRestingPosition(mover, others, { h: 800 });
    expectClear(mover, pos, others);
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.y + mover.h).toBeLessThanOrEqual(800);
  });

  it("goes sideways when the mover is vertically boxed in", () => {
    // The column is fully occupied: a 400-tall mover cannot clear a 380-tall
    // obstacle at y=0 and another at y=390 inside an 800 floor. Horizontal is
    // the escape valve.
    const mover: VesselRect = { id: "M", x: 100, y: 200, w: 300, h: 400 };
    const others: VesselRect[] = [
      { id: "A", x: 100, y: 0, w: 300, h: 380 },
      { id: "B", x: 100, y: 390, w: 300, h: 380 },
    ];
    const pos = findRestingPosition(mover, others, { h: 800 });
    expectClear(mover, pos, others);
    expect(pos.x).not.toBe(100);
  });

  it("may settle at a negative x — store coordinates are signed", () => {
    // Boxed in on the right by a wide obstacle whose left edge is at 0: the
    // nearest clear ground is leftward past zero.
    const mover: VesselRect = { id: "M", x: 0, y: 0, w: 300, h: 300 };
    const others: VesselRect[] = [{ id: "A", x: 20, y: 0, w: 2000, h: 800 }];
    const pos = findRestingPosition(mover, others, { h: 800 });
    expectClear(mover, pos, others);
    expect(pos.x).toBeLessThan(0);
  });

  it("keeps the resting coordinate on the snap lattice", () => {
    const mover: VesselRect = { id: "M", x: 307, y: 203, w: 300, h: 400 };
    const others: VesselRect[] = [
      { id: "A", x: 421, y: 219, w: 300, h: 400 },
      { id: "B", x: 533, y: 187, w: 300, h: 400 },
    ];
    const pos = findRestingPosition(mover, others, { h: 800 });
    expect(pos.x % GRID).toBe(0);
    expect(pos.y % GRID).toBe(0);
    expectClear(mover, pos, others);
  });

  it("is idempotent: a settled position settles to itself", () => {
    const mover: VesselRect = { id: "M", x: 400, y: 200, w: 300, h: 400 };
    const others: VesselRect[] = [
      { id: "A", x: 420, y: 220, w: 300, h: 400 },
      { id: "B", x: 440, y: 180, w: 300, h: 400 },
    ];
    const first = findRestingPosition(mover, others, { h: 800 });
    const second = findRestingPosition(
      { ...mover, ...first },
      others,
      { h: 800 },
    );
    expect(second).toEqual(first);
  });

  it("works with no floor bounds supplied", () => {
    const mover: VesselRect = { id: "M", x: 300, y: 100, w: 300, h: 400 };
    const others: VesselRect[] = [{ id: "A", x: 560, y: 100, w: 300, h: 400 }];
    expectClear(mover, findRestingPosition(mover, others), others);
  });

  it("finds clear ground even dropped into a large pile", () => {
    const mover: VesselRect = { id: "M", x: 200, y: 0, w: 100, h: 100 };
    const others: VesselRect[] = Array.from({ length: 50 }, (_, i) => ({
      id: `v${i}`,
      x: i * 10,
      y: 0,
      w: 100,
      h: 100,
    }));
    expectClear(mover, findRestingPosition(mover, others, { h: 500 }), others);
  });

  // The invariant is universal ("no overlap in any scenario"), so the
  // strongest guard is a property over many layouts rather than a handful of
  // fixtures. Widths run to resize scale — VESSEL_MAX_W is 2000 and a resize
  // commit changes the rect placement reasons about; a corpus that stops
  // where legal gestures keep going proves nothing about them (the
  // 2026-07-21 push-wave counterexamples all lived above a 420px cap).
  it("always returns a clear, in-bounds, lattice-aligned spot across randomised layouts", () => {
    // Deterministic PRNG (mulberry32) — reproducible failures, no flakes.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));

    for (let trial = 0; trial < 3000; trial++) {
      const floorH = 800;
      const count = pick(2, 10);
      // Sizes deliberately OFF the lattice: the resting position must be
      // clear even when an obstacle's edge falls mid-cell.
      const mover: VesselRect = {
        id: "M",
        x: pick(0, 120) * 10,
        y: pick(0, 40) * 10,
        w: pick(220, 1600),
        h: pick(200, 600),
      };
      // A legal fixture is a RESTING floor: the others are mutually clear
      // (the invariant held before the gesture) and in bounds. Only the mover
      // overlaps them — that is the disturbance being placed. Rejection-
      // sample rather than assert, so the corpus stays legal by construction.
      const others: VesselRect[] = [];
      for (let i = 0; i < count; i++) {
        const c: VesselRect = {
          id: `v${i}`,
          x: pick(0, 60) * 10,
          y: pick(0, 40) * 10,
          w: pick(220, 900),
          h: pick(200, 500),
        };
        if (c.y + c.h > floorH) continue;
        if (others.some((o) => overlaps(o, c))) continue;
        others.push(c);
      }
      if (mover.y + mover.h > floorH) continue;
      if (others.length < 2) continue;

      const pos = findRestingPosition(mover, others, { h: floorH });
      const label = `trial ${trial}`;
      const settled = { ...mover, x: pos.x, y: pos.y };
      for (const o of others) {
        expect(overlaps(settled, o), `${label}: mover overlaps ${o.id}`).toBe(
          false,
        );
      }
      expect(pos.y, `${label}: above the floor`).toBeGreaterThanOrEqual(0);
      expect(
        pos.y + mover.h,
        `${label}: below the floor`,
      ).toBeLessThanOrEqual(floorH);
      // Math.abs: a negative lattice x makes `%` return -0, which toBe(0)
      // rejects under Object.is.
      expect(Math.abs(pos.x % GRID), `${label}: x off-lattice`).toBe(0);
      expect(Math.abs(pos.y % GRID), `${label}: y off-lattice`).toBe(0);
    }
  });
});

describe("clampSizeClear", () => {
  const origin = { x: 100, y: 100 };
  const start = { w: 300, h: 400 };

  it("returns the proposal untouched when nothing is hit", () => {
    const others: VesselRect[] = [{ id: "A", x: 900, y: 100, w: 300, h: 400 }];
    expect(clampSizeClear(origin, start, { w: 500, h: 500 }, others)).toEqual({
      w: 500,
      h: 500,
    });
  });

  it("stops a horizontal stretch at the neighbour's edge", () => {
    const others: VesselRect[] = [{ id: "A", x: 500, y: 100, w: 300, h: 400 }];
    expect(clampSizeClear(origin, start, { w: 700, h: 400 }, others)).toEqual({
      w: 400,
      h: 400,
    });
  });

  it("stops a vertical stretch at the neighbour's edge", () => {
    const others: VesselRect[] = [{ id: "A", x: 100, y: 600, w: 300, h: 200 }];
    expect(clampSizeClear(origin, start, { w: 300, h: 700 }, others)).toEqual({
      w: 300,
      h: 496,
    });
  });

  it("cuts the axis losing less of the proposal on a diagonal stretch", () => {
    // Obstacle at the diagonal corner: cutting w loses 200 of the proposal,
    // cutting h loses ~104 — h yields.
    const others: VesselRect[] = [{ id: "A", x: 500, y: 600, w: 300, h: 200 }];
    expect(clampSizeClear(origin, start, { w: 600, h: 600 }, others)).toEqual({
      w: 600,
      h: 496,
    });
  });

  it("clears multiple neighbours in one gesture", () => {
    const others: VesselRect[] = [
      { id: "A", x: 600, y: 100, w: 300, h: 400 }, // right
      { id: "B", x: 100, y: 550, w: 300, h: 200 }, // below
    ];
    const sized = clampSizeClear(origin, start, { w: 900, h: 900 }, others);
    const rect = { id: "M", x: origin.x, y: origin.y, ...sized };
    for (const o of others) {
      expect(overlaps(rect, o)).toBe(false);
    }
  });

  it("snaps the cut to the lattice, outward-safe (floor, never round)", () => {
    // Neighbour's left edge mid-cell at x=497: the widest lattice width that
    // clears is 392, not 397.
    const others: VesselRect[] = [{ id: "A", x: 497, y: 100, w: 300, h: 400 }];
    expect(clampSizeClear(origin, start, { w: 700, h: 400 }, others)).toEqual({
      w: 392,
      h: 400,
    });
  });

  it("falls back to the start size when no valid cut exists", () => {
    // An obstacle already intersecting the start rect is outside the
    // function's contract (a resting state is clear); the safe answer is the
    // last size the invariant vouched for.
    const others: VesselRect[] = [{ id: "A", x: 150, y: 150, w: 100, h: 100 }];
    expect(clampSizeClear(origin, start, { w: 500, h: 500 }, others)).toEqual(
      start,
    );
  });
});

describe("repairRestingLayout", () => {
  it("returns no updates for a layout that is already clear", () => {
    const rects: VesselRect[] = [
      { id: "a", x: 0, y: 0, w: 300, h: 400 },
      { id: "b", x: 320, y: 0, w: 300, h: 400 },
    ];
    expect(repairRestingLayout(rects).size).toBe(0);
  });

  // The signature symptom of the pre-2026-07-21 push-wave resolver's livelock
  // exit — and what the hydrate heal exists for.
  it("shelves an identical-coordinate stack clear", () => {
    const rects: VesselRect[] = [
      { id: "a", x: 820, y: 300, w: 340, h: 260 },
      { id: "b", x: 820, y: 300, w: 250, h: 260 },
      { id: "c", x: 0, y: 0, w: 300, h: 200 },
    ];
    const updates = repairRestingLayout(rects);
    expect(updates.size).toBe(1);
    const settled = rects.map((r) => {
      const u = updates.get(r.id);
      return u ? { ...r, x: u.x, y: u.y } : r;
    });
    for (let i = 0; i < settled.length; i++) {
      for (let j = i + 1; j < settled.length; j++) {
        expect(overlaps(settled[i], settled[j])).toBe(false);
      }
    }
  });

  it("never moves the pinned rect", () => {
    const rects: VesselRect[] = [
      { id: "held", x: 500, y: 100, w: 300, h: 400 },
      { id: "under", x: 500, y: 100, w: 300, h: 400 },
    ];
    const updates = repairRestingLayout(rects, { pinned: "held" });
    expect(updates.has("held")).toBe(false);
    expect(updates.has("under")).toBe(true);
  });

  it("keeps shelved vessels mutually clear whatever their heights", () => {
    // Three vessels all stacked on a fourth at the same y-band: each must
    // advance the shelf, not share it.
    const rects: VesselRect[] = [
      { id: "base", x: 0, y: 0, w: 400, h: 400 },
      { id: "p1", x: 10, y: 10, w: 300, h: 400 },
      { id: "p2", x: 20, y: 20, w: 300, h: 400 },
      { id: "p3", x: 30, y: 30, w: 300, h: 400 },
    ];
    const updates = repairRestingLayout(rects, { pinned: "base" });
    expect(updates.size).toBe(3);
    const settled = rects.map((r) => {
      const u = updates.get(r.id);
      return u ? { ...r, x: u.x, y: u.y } : r;
    });
    for (let i = 0; i < settled.length; i++) {
      for (let j = i + 1; j < settled.length; j++) {
        expect(overlaps(settled[i], settled[j])).toBe(false);
      }
    }
    // Everything shelved landed on the lattice.
    for (const [, u] of updates) {
      expect(u.x % GRID).toBe(0);
    }
  });
});
