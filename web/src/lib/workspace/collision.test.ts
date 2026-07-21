import { describe, it, expect } from "vitest";
import {
  resolveCollisions,
  repairRestingLayout,
  type VesselRect,
} from "./collision";

// The invariant under test (WORKSPACE-DESIGN-SPEC.md › Addendum — No-overlap
// governs the resting state): after resolution NOTHING overlaps — not the
// pushed vessels with each other, and not any of them with the mover. The
// resolver must always succeed, because the floor is unbounded sideways and
// horizontal is the escape valve.

function overlaps(a: VesselRect, b: VesselRect): boolean {
  return !(
    a.x >= b.x + b.w ||
    a.x + a.w <= b.x ||
    a.y >= b.y + b.h ||
    a.y + a.h <= b.y
  );
}

/** Apply the resolver's updates to `others` and return the resting layout. */
function settle(
  mover: VesselRect,
  others: VesselRect[],
  floorBounds?: { h: number },
): VesselRect[] {
  const updates = resolveCollisions(mover, others, floorBounds);
  return others.map((o) => {
    const u = updates.get(o.id);
    return u ? { ...o, x: u.x, y: u.y } : o;
  });
}

function expectNoOverlaps(mover: VesselRect, settled: VesselRect[]) {
  for (const v of settled) {
    expect(
      overlaps(mover, v),
      `${v.id} at (${v.x},${v.y}) still overlaps the mover`,
    ).toBe(false);
  }
  for (let i = 0; i < settled.length; i++) {
    for (let j = i + 1; j < settled.length; j++) {
      expect(
        overlaps(settled[i], settled[j]),
        `${settled[i].id} at (${settled[i].x},${settled[i].y}) overlaps ${settled[j].id} at (${settled[j].x},${settled[j].y})`,
      ).toBe(false);
    }
  }
}

describe("resolveCollisions", () => {
  it("leaves a non-overlapping layout untouched", () => {
    const mover: VesselRect = { id: "M", x: 0, y: 100, w: 300, h: 400 };
    const others: VesselRect[] = [
      { id: "A", x: 400, y: 100, w: 300, h: 400 },
      { id: "B", x: 800, y: 100, w: 300, h: 400 },
    ];
    expect(resolveCollisions(mover, others, { h: 800 }).size).toBe(0);
  });

  it("pushes a single overlapping neighbour clear", () => {
    const mover: VesselRect = { id: "M", x: 300, y: 100, w: 300, h: 400 };
    const others: VesselRect[] = [{ id: "A", x: 560, y: 100, w: 300, h: 400 }];
    expectNoOverlaps(mover, settle(mover, others, { h: 800 }));
  });

  // Regression — bug hunt 2026-07-20, scenario B. A 20px nudge into a row of
  // six threw one vessel 1780px right and left two of them stacked at exactly
  // x=2080: an already-displaced vessel was re-pushed but never re-enqueued as
  // a pusher (the `visited` guard), so the second displacement never
  // propagated.
  it("does not stack vessels when nudging into a packed row", () => {
    // A tidy row: 300 wide on a 320 pitch, so the fixture itself is clear and
    // any displacement in the result is the resolver's doing.
    const mover: VesselRect = { id: "M", x: 340, y: 100, w: 300, h: 400 };
    const others: VesselRect[] = Array.from({ length: 6 }, (_, i) => ({
      id: `v${i}`,
      x: 600 + i * 320,
      y: 100,
      w: 300,
      h: 400,
    }));
    const settled = settle(mover, others, { h: 800 });
    expectNoOverlaps(mover, settled);
    // A 40px nudge propagates as a 40px shuffle — nobody is flung across the
    // floor, and nobody ends up stacked on a neighbour.
    for (const v of settled) {
      const from = others.find((o) => o.id === v.id)!;
      expect(
        Math.abs(v.x - from.x),
        `${v.id} was displaced ${Math.abs(v.x - from.x)}px`,
      ).toBeLessThan(200);
    }
  });

  // Regression — bug hunt 2026-07-20, scenario A. The vertical push was
  // clamped to the viewport floor and the clamped result accepted, leaving the
  // vessel underneath the mover. Horizontal is the escape valve: with no
  // vertical room the resolver must go sideways instead.
  it("falls back to a horizontal push when the vertical one would clamp", () => {
    // Two tall vessels, fully overlapping in x and barely (20px) in y. The
    // cheapest move by far is DOWN (cost 20 vs 300 sideways) — but 380+370
    // clears the 760 floor only where it stands; pushed to y=400 it would need
    // 770. Up is impossible too (y would go negative). So the resolver must
    // spend the expensive horizontal move rather than accept the overlap.
    const mover: VesselRect = { id: "M", x: 100, y: 0, w: 300, h: 400 };
    const others: VesselRect[] = [{ id: "A", x: 100, y: 380, w: 300, h: 370 }];
    const settled = settle(mover, others, { h: 760 });
    expectNoOverlaps(mover, settled);
    expect(settled[0].y, "should not have moved vertically").toBe(380);
    expect(settled[0].x, "should have gone sideways instead").toBe(400);
    expect(settled[0].y + settled[0].h).toBeLessThanOrEqual(760);
    expect(settled[0].y).toBeGreaterThanOrEqual(0);
  });

  it("never parks a pushed vessel outside the vertical bound", () => {
    const mover: VesselRect = { id: "M", x: 100, y: 0, w: 300, h: 300 };
    const others: VesselRect[] = [
      { id: "A", x: 120, y: 40, w: 300, h: 700 },
      { id: "B", x: 140, y: 80, w: 300, h: 700 },
    ];
    // Fixture must itself be in bounds: 80 + 700 <= 800. The resolver's job is
    // to not create an out-of-bounds resting position, not to repair one that
    // a viewport shrink left behind.
    const settled = settle(mover, others, { h: 800 });
    expectNoOverlaps(mover, settled);
    for (const v of settled) {
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.y + v.h).toBeLessThanOrEqual(800);
    }
  });

  // The mover is the thing the user is holding: it must never be displaced,
  // and a chain push must never land a vessel back underneath it.
  it("treats the mover as immovable and never pushes anything under it", () => {
    const mover: VesselRect = { id: "M", x: 500, y: 100, w: 300, h: 400 };
    const others: VesselRect[] = [
      { id: "A", x: 480, y: 100, w: 300, h: 400 },
      { id: "B", x: 220, y: 100, w: 300, h: 400 },
      { id: "C", x: 760, y: 100, w: 300, h: 400 },
    ];
    const updates = resolveCollisions(mover, others, { h: 800 });
    expect(updates.has("M")).toBe(false);
    expectNoOverlaps(mover, settle(mover, others, { h: 800 }));
  });

  it("resolves a dense cluster with no residual overlaps", () => {
    const mover: VesselRect = { id: "M", x: 400, y: 200, w: 300, h: 400 };
    const others: VesselRect[] = [
      { id: "A", x: 420, y: 220, w: 300, h: 400 },
      { id: "B", x: 440, y: 180, w: 300, h: 400 },
      { id: "C", x: 380, y: 240, w: 300, h: 400 },
      { id: "D", x: 460, y: 260, w: 300, h: 400 },
    ];
    expectNoOverlaps(mover, settle(mover, others, { h: 800 }));
  });

  it("resolves regardless of the order others are supplied in", () => {
    const mover: VesselRect = { id: "M", x: 400, y: 200, w: 300, h: 400 };
    const base: VesselRect[] = [
      { id: "A", x: 420, y: 220, w: 300, h: 400 },
      { id: "B", x: 440, y: 180, w: 300, h: 400 },
      { id: "C", x: 380, y: 240, w: 300, h: 400 },
    ];
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
    ]) {
      expectNoOverlaps(
        mover,
        settle(
          mover,
          order.map((i) => base[i]),
          { h: 800 },
        ),
      );
    }
  });

  it("keeps every resting coordinate on the snap lattice", () => {
    const mover: VesselRect = { id: "M", x: 307, y: 203, w: 300, h: 400 };
    const others: VesselRect[] = [
      { id: "A", x: 421, y: 219, w: 300, h: 400 },
      { id: "B", x: 533, y: 187, w: 300, h: 400 },
    ];
    for (const [, u] of resolveCollisions(mover, others, { h: 800 })) {
      expect(u.x % 10).toBe(0);
      expect(u.y % 10).toBe(0);
    }
  });

  // The invariant is universal ("no overlap in any scenario"), so the strongest
  // guard is a property over many layouts rather than a handful of fixtures.
  // Hand-built cases happen to be resolvable in a single wave and in whole
  // lattice cells; these are not. This is what holds rule 3 (a vessel displaced
  // twice must propagate twice) and the directional snap — with a `visited`
  // guard, or with round-to-nearest instead of ceil/floor, layouts in here
  // settle still overlapping.
  it("leaves no overlap across randomised layouts", () => {
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
      // Sizes deliberately OFF the lattice: a resting position must be clear of
      // its obstacle even when the obstacle's edge falls mid-cell. Widths run
      // to resize scale — VESSEL_MAX_W is 2000 and a resize commit is a mover.
      // The original corpus capped the mover at 420px, and both 2026-07-21
      // counterexamples (the livelock, the load-bearing guard removal) live
      // exclusively above that cap: a corpus that stops where legal gestures
      // keep going proves nothing about them.
      const mover: VesselRect = {
        id: "M",
        x: pick(0, 120) * 10,
        y: pick(0, 40) * 10,
        w: pick(220, 1600),
        h: pick(200, 600),
      };
      // A legal fixture is a RESTING floor: the others are mutually clear (the
      // invariant held before the gesture) and in bounds. Only the mover
      // overlaps them — that is the disturbance being resolved. Rejection-sample
      // rather than assert, so the corpus stays legal by construction.
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

      const settled = settle(mover, others, { h: floorH });
      const label = `trial ${trial}`;
      for (const v of settled) {
        expect(overlaps(mover, v), `${label}: ${v.id} overlaps the mover`).toBe(
          false,
        );
        expect(v.y, `${label}: ${v.id} above the floor`).toBeGreaterThanOrEqual(
          0,
        );
        expect(
          v.y + v.h,
          `${label}: ${v.id} below the floor`,
        ).toBeLessThanOrEqual(floorH);
      }
      for (let i = 0; i < settled.length; i++) {
        for (let j = i + 1; j < settled.length; j++) {
          expect(
            overlaps(settled[i], settled[j]),
            `${label}: ${settled[i].id} overlaps ${settled[j].id}`,
          ).toBe(false);
        }
      }
    }
  });

  it("works with no floor bounds supplied", () => {
    const mover: VesselRect = { id: "M", x: 300, y: 100, w: 300, h: 400 };
    const others: VesselRect[] = [{ id: "A", x: 560, y: 100, w: 300, h: 400 }];
    expectNoOverlaps(mover, settle(mover, others));
  });

  // ── Ported from the superseded tests/collision.test.ts ──────────────────
  // That file predated the infinite floor (fef39d1) and still asserted a
  // horizontal bound and x >= 0. Those two expectations are now backwards —
  // see the signed-coordinate test below — but the rest of its coverage is
  // still worth holding.

  it("picks the axis of minimum displacement", () => {
    const mover: VesselRect = { id: "M", x: 0, y: 0, w: 100, h: 100 };
    const others: VesselRect[] = [{ id: "B", x: 90, y: 0, w: 100, h: 100 }];
    const pos = resolveCollisions(mover, others, { h: 500 }).get("B")!;
    expect(pos.x).toBe(100);
    expect(pos.y).toBe(0);
  });

  it("pushes upward when the overlap is smallest from the bottom", () => {
    const mover: VesselRect = { id: "M", x: 0, y: 50, w: 100, h: 100 };
    const others: VesselRect[] = [{ id: "B", x: 0, y: 0, w: 100, h: 60 }];
    const pos = resolveCollisions(mover, others, { h: 500 }).get("B")!;
    expect(pos.y).toBeLessThan(50);
  });

  it("cascades along a chain without reordering it", () => {
    const mover: VesselRect = { id: "M", x: 0, y: 0, w: 100, h: 100 };
    const others: VesselRect[] = [
      { id: "B", x: 50, y: 0, w: 100, h: 100 },
      { id: "C", x: 150, y: 0, w: 100, h: 100 },
    ];
    const updates = resolveCollisions(mover, others, { h: 500 });
    expect(updates.has("B")).toBe(true);
    expect(updates.has("C")).toBe(true);
    expect(updates.get("B")!.x + 100).toBeLessThanOrEqual(
      updates.get("C")!.x + 1,
    );
  });

  // Inverts the superseded "clamps negative positions to 0". Store
  // coordinates are SIGNED with no origin — a vessel may sit at negative x and
  // the canvas extent grows leftward to cover it. Clamping x at 0 would pin
  // vessels against an edge the infinite floor does not have.
  it("allows a pushed vessel to take a negative x", () => {
    const mover: VesselRect = { id: "M", x: 0, y: 0, w: 300, h: 300 };
    const others: VesselRect[] = [
      // Sitting just left of the mover, and boxed in on the right by the mover
      // itself, so the only way out is leftward past zero.
      { id: "B", x: -20, y: 0, w: 300, h: 300 },
    ];
    const pos = resolveCollisions(mover, others, { h: 500 }).get("B")!;
    expect(pos.x).toBeLessThan(0);
    expectNoOverlaps(mover, settle(mover, others, { h: 500 }));
  });

  // DELIBERATE ILLEGAL FIXTURE — the one exemption from the legal-fixture
  // rule in this file. Fifty mutually-overlapping vessels is not a resting
  // floor; it exists to exercise the verify-and-repair backstop, which must
  // return a mutually-clear layout even from garbage input (that is what the
  // hydrate heal relies on). The wave-quality fixtures above stay legal.
  it("clears even a large pile of mutually overlapping vessels", () => {
    const mover: VesselRect = { id: "M", x: 0, y: 0, w: 100, h: 100 };
    const others: VesselRect[] = Array.from({ length: 50 }, (_, i) => ({
      id: `v${i}`,
      x: i * 10,
      y: 0,
      w: 100,
      h: 100,
    }));
    expectNoOverlaps(mover, settle(mover, others, { h: 500 }));
  });

  // ── 2026-07-21 counterexamples (found by randomized probe, review of
  // 4c933eb). Both live above the old corpus's 420px mover cap. ─────────────

  // A true livelock: at ANY budget the wave never drains on this geometry —
  // the wide mover leaves its overlappers cycling between each other's escape
  // candidates. The budget exit used to return the intermediate state, which
  // rested v0 and v1 fully coincident at (820,300): the exact
  // identical-coordinate stacking the resolver exists to abolish, silently
  // persisted. This pins the exhaustion path: whatever the wave leaves, the
  // output must be clear and in bounds.
  it("keeps the invariant when the wave livelocks (wide mover)", () => {
    const mover: VesselRect = { id: "M", x: 20, y: 210, w: 800, h: 350 };
    const others: VesselRect[] = [
      { id: "v0", x: 510, y: 0, w: 340, h: 260 },
      { id: "v1", x: 340, y: 300, w: 250, h: 260 },
      { id: "v3", x: 750, y: 310, w: 400, h: 230 },
    ];
    const settled = settle(mover, others, { h: 760 });
    expectNoOverlaps(mover, settled);
    for (const v of settled) {
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.y + v.h).toBeLessThanOrEqual(760);
    }
  });

  // The `visited` guard is LOAD-BEARING to omit, not defensive: a vessel's
  // second displacement can land it on a third vessel, and with a guard it is
  // never re-enqueued, so nothing ever tests that pair again — a resting
  // overlap. The wave (guard-free) resolves this layout properly, everything
  // settling left of the mover; a reinstated guard leaves an overlap that
  // only the repair shelf can clear, which parks a vessel PAST the mover's
  // right edge (x ≥ 1520). The position bound is what makes this fixture kill
  // the guard mutation — the no-overlap assertion alone would be satisfied by
  // guard + shelf.
  it("propagates a second displacement (no visited guard)", () => {
    const mover: VesselRect = { id: "M", x: 680, y: 270, w: 830, h: 220 };
    const others: VesselRect[] = [
      { id: "A", x: 190, y: 10, w: 280, h: 410 },
      { id: "B", x: 470, y: 310, w: 280, h: 390 },
      { id: "C", x: 790, y: 40, w: 430, h: 410 },
    ];
    const settled = settle(mover, others, { h: 760 });
    expectNoOverlaps(mover, settled);
    for (const v of settled) {
      expect(
        v.x,
        `${v.id} was shelved instead of wave-resolved`,
      ).toBeLessThan(mover.x + mover.w);
    }
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

  // The signature symptom of the pre-2026-07-21 resolver's livelock exit —
  // and what the hydrate heal exists for.
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
      expect(u.x % 10).toBe(0);
    }
  });
});
