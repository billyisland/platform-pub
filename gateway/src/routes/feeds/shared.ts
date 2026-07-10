import { pool } from "@platform-pub/shared/db/client.js";

// Shared helpers for the workspace-feeds route modules (crud / items / sources /
// author-volume / saves). Anything consumed by ≥2 of those modules lives here so
// the split stays a pure move — no behaviour change. Module-private helpers stay
// with their module.

export { UUID_RE } from "../../lib/uuid.js";

export interface FeedRow {
  id: string;
  name: string;
  appearance: Record<string, unknown>;
  sort_rank: number;
  hidden: boolean;
  created_at: Date;
  updated_at: Date;
  source_count: number;
}

export function feedRowToResponse(row: FeedRow) {
  return {
    id: row.id,
    name: row.name,
    appearance: row.appearance ?? {},
    sortRank: row.sort_rank,
    hidden: row.hidden,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sourceCount: Number(row.source_count),
  };
}

export async function loadFeed(
  feedId: string,
  ownerId: string,
): Promise<FeedRow | null> {
  const { rows } = await pool.query<FeedRow>(
    `SELECT f.id, f.name, f.appearance, f.sort_rank, f.hidden, f.created_at, f.updated_at,
       (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count
     FROM feeds f
     WHERE f.id = $1 AND f.owner_id = $2`,
    [feedId, ownerId],
  );
  return rows[0] ?? null;
}

export function tagged(
  code: string,
  message?: string,
): Error & { code: string } {
  const e = new Error(message ?? code) as Error & { code: string };
  e.code = code;
  return e;
}

// Slice 14 — five-step volume bar mapping. Step 0 is muted (handled via
// muted_at, not weight). Step 3 is the "default" weight kept in alignment
// with feed_sources.weight DEFAULT 1.0 so a passive→committed transition at
// step 3 doesn't change ranking once weight is wired.
const VOLUME_WEIGHTS = [1.0, 0.25, 0.5, 1.0, 2.0, 4.0];
export function stepToWeight(step: number): number {
  return VOLUME_WEIGHTS[Math.max(0, Math.min(5, step))] ?? 1.0;
}
export function weightToStep(weight: number): number {
  // Inverse — picks the closest committed step. Used only for read-back so
  // a hand-edited weight in the DB still reads back as a sensible bar position.
  let bestStep = 3;
  let bestDelta = Infinity;
  for (let s = 1; s <= 5; s++) {
    const d = Math.abs(VOLUME_WEIGHTS[s] - weight);
    if (d < bestDelta) {
      bestDelta = d;
      bestStep = s;
    }
  }
  return bestStep;
}
