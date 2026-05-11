export const GRID = 20; // px — coarse enough to feel structured, fine enough to place precisely

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}
