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
  // Computed provenance (EXPLAIN-ADR D7): true iff this feed is a clone of a
  // starter template. Drives the first-run / Explain copy fork. Derived from
  // the existing feeds.cloned_from_feed_id — no column, no leaked template id.
  from_starter: boolean;
  // Where a redeemed feed came from (FEED-FORMULAS-ADR D7). Both NULL unless
  // the feed was minted by redeeming a formula. Deliberately a SECOND question
  // from from_starter, which today still means "cloned from the flagged
  // template": Phase 2 makes the seed itself a formula, at which point
  // from_starter is re-derived from is_default_seed and these two stop
  // overlapping. Attribution travels; adoption counts do not — nothing here
  // tells the author anything about uptake.
  origin_formula_name: string | null;
  origin_author_name: string | null;
}

// The provenance projection, in ONE place.
//
// It used to be a hand-copied EXISTS at five sites (loadFeed, listFeedsForOwner,
// two inline SELECTs inside registerFeedCrudRoutes, and createFeedForOwner's
// literal `false`) — which is exactly why FEED-FORMULAS-ADR §11 has to warn a
// future reader to *grep* for from_starter rather than trust a list. Copies
// drift; a function cannot. Phase 2 re-derives from_starter off
// feed_formulas.is_default_seed by editing this one body.
//
// `alias` is interpolated into SQL and is a compile-time literal at every call
// site (the table alias in that query — `f`, or the table name itself inside a
// RETURNING). It never carries user input.
export function feedProvenanceSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM feeds t
                  WHERE t.id = ${alias}.cloned_from_feed_id AND t.is_starter_template) AS from_starter,
     (SELECT ff.name FROM feed_formulas ff WHERE ff.id = ${alias}.from_formula_id) AS origin_formula_name,
     (SELECT COALESCE(a.display_name, a.username)
        FROM feed_formulas ff JOIN accounts a ON a.id = ff.author_id
       WHERE ff.id = ${alias}.from_formula_id) AS origin_author_name`;
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
    fromStarter: row.from_starter,
    // Absent rather than null when there is nothing to say, so the client's
    // "where did this come from" line is a presence check.
    origin: row.origin_formula_name
      ? {
          formulaName: row.origin_formula_name,
          authorName: row.origin_author_name,
        }
      : null,
  };
}

export async function loadFeed(
  feedId: string,
  ownerId: string,
): Promise<FeedRow | null> {
  const { rows } = await pool.query<FeedRow>(
    `SELECT f.id, f.name, f.appearance, f.sort_rank, f.hidden, f.created_at, f.updated_at,
       (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count,
       ${feedProvenanceSql("f")}
     FROM feeds f
     WHERE f.id = $1 AND f.owner_id = $2`,
    [feedId, ownerId],
  );
  return rows[0] ?? null;
}

// §6.4b — spacing between consecutive sources' subscribe-time ingest jobs, for
// any caller that adds sources in bulk. A 500-source import trickles its jobs
// over ~4 minutes instead of dumping 500 immediate fetches on a 10-concurrency
// worker; formula redemption rides the same brake. One home, because two bulk
// paths tuning the worker to different numbers is how a soak result gets lost.
export const ENQUEUE_SPACING_MS = 500;

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
