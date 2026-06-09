// 20px = LCM(10, 4): keeps the vessel floor in phase with the 4px design
// rhythm (Tailwind spacing + the 4px slab) so chrome and content share a lattice.
export const GRID = 20;

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}
