export const GRID = 10;

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}
