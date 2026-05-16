import { describe, it, expect } from "vitest";
import {
  resolveCollisions,
  type VesselRect,
} from "../src/lib/workspace/collision";

function rect(id: string, x: number, y: number, w = 100, h = 100): VesselRect {
  return { id, x, y, w, h };
}

describe("resolveCollisions", () => {
  it("returns empty map when no overlap", () => {
    const mover = rect("A", 0, 0);
    const others = [rect("B", 200, 200)];
    const updates = resolveCollisions(mover, others);
    expect(updates.size).toBe(0);
  });

  it("pushes a single overlapping vessel", () => {
    const mover = rect("A", 0, 0);
    const others = [rect("B", 50, 0)];
    const updates = resolveCollisions(mover, others);
    expect(updates.has("B")).toBe(true);
    const pos = updates.get("B")!;
    expect(pos.x).toBeGreaterThanOrEqual(100);
    expect(pos.y).toBe(0);
  });

  it("resolves push direction to minimum displacement", () => {
    const mover = rect("A", 0, 0, 100, 100);
    const others = [rect("B", 90, 0, 100, 100)];
    const updates = resolveCollisions(mover, others);
    const pos = updates.get("B")!;
    expect(pos.x).toBe(100);
    expect(pos.y).toBe(0);
  });

  it("pushes upward when overlap is smaller from bottom", () => {
    const mover = rect("A", 0, 50, 100, 100);
    const others = [rect("B", 0, 0, 100, 60)];
    const updates = resolveCollisions(mover, others);
    const pos = updates.get("B")!;
    expect(pos.y).toBeLessThan(50);
  });

  it("handles chain cascade A→B→C", () => {
    const mover = rect("A", 0, 0);
    const others = [rect("B", 50, 0), rect("C", 150, 0)];
    const updates = resolveCollisions(mover, others);
    expect(updates.has("B")).toBe(true);
    expect(updates.has("C")).toBe(true);
    const bPos = updates.get("B")!;
    const cPos = updates.get("C")!;
    expect(bPos.x + 100).toBeLessThanOrEqual(cPos.x + 1);
  });

  it("clamps to floor bounds", () => {
    const mover = rect("A", 0, 0);
    const others = [rect("B", 50, 0)];
    const bounds = { w: 200, h: 200 };
    const updates = resolveCollisions(mover, others, bounds);
    const pos = updates.get("B")!;
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.x + 100).toBeLessThanOrEqual(200);
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.y + 100).toBeLessThanOrEqual(200);
  });

  it("clamps negative positions to 0", () => {
    const mover = rect("A", 10, 0, 100, 100);
    const others = [rect("B", 0, 0, 20, 100)];
    const bounds = { w: 500, h: 500 };
    const updates = resolveCollisions(mover, others, bounds);
    if (updates.has("B")) {
      const pos = updates.get("B")!;
      expect(pos.x).toBeGreaterThanOrEqual(0);
      expect(pos.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("snaps positions to grid", () => {
    const mover = rect("A", 0, 0);
    const others = [rect("B", 50, 0)];
    const updates = resolveCollisions(mover, others);
    const pos = updates.get("B")!;
    expect(pos.x % 10).toBe(0);
    expect(pos.y % 10).toBe(0);
  });

  it("does not move disjoint vessels", () => {
    const mover = rect("A", 0, 0, 50, 50);
    const others = [rect("B", 300, 300), rect("C", 500, 500)];
    const updates = resolveCollisions(mover, others);
    expect(updates.size).toBe(0);
  });

  it("does not move the mover itself", () => {
    const mover = rect("A", 0, 0);
    const others = [rect("B", 50, 0)];
    const updates = resolveCollisions(mover, others);
    expect(updates.has("A")).toBe(false);
  });

  it("terminates with many overlapping vessels (30-iteration safety cap)", () => {
    const mover = rect("mover", 0, 0, 100, 100);
    const others: VesselRect[] = [];
    for (let i = 0; i < 50; i++) {
      others.push(rect(`v${i}`, i * 10, 0, 100, 100));
    }
    const updates = resolveCollisions(mover, others);
    expect(updates.size).toBeGreaterThan(0);
    expect(updates.size).toBeLessThanOrEqual(50);
  });
});
