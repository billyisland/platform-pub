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
  // Computed provenance (EXPLAIN-ADR D7): true iff this feed is what the
  // platform set up for its owner rather than something they composed. Drives
  // the first-run / Explain copy fork. No column, no leaked seed id.
  from_starter: boolean;
  // Where a redeemed feed came from (FEED-FORMULAS-ADR D7). Both NULL unless
  // the feed was minted by redeeming SOMEBODY'S formula — the default seed is
  // deliberately not that: it is from_starter's question, and answering both
  // would put "from <the operator>'s Starter" on every new member's first feed.
  // The two are disjoint by construction (see feedProvenanceSql). Attribution
  // travels; adoption counts do not — nothing here tells the author anything
  // about uptake.
  origin_formula_name: string | null;
  origin_author_name: string | null;
}

// The provenance projection, in ONE place.
//
// It used to be a hand-copied EXISTS at five sites (loadFeed, listFeedsForOwner,
// two inline SELECTs inside registerFeedCrudRoutes, and createFeedForOwner's
// literal `false`) — which is exactly why FEED-FORMULAS-ADR §11 has to warn a
// future reader to *grep* for from_starter rather than trust a list. Copies
// drift; a function cannot. Phase 2 re-derived from_starter here, in one body.
//
// TWO arms, and both are permanent:
//
//   • the designated default-seed formula — what seedStarterFeeds redeems for
//     every new account from Phase 2 onwards;
//   • `cloned_from_feed_id IS NOT NULL` — the legacy arm, and now a read-only
//     one: its sole writer was cloneFeedForOwner, deleted with
//     `feeds.is_starter_template` in migration 179. Nothing sets the column any
//     more, but it is the only provenance members seeded BEFORE that cutover
//     have (§11), so the arm stays. It must not be spelled as an EXISTS over
//     the flag, which is why step 1 re-derived it here a migration ahead of the
//     drop: under the old spelling, merely UNFLAGGING the template retroactively
//     unmade the provenance of every member ever seeded from it, and dropping
//     the column would have done the same to all of them at once. Provenance is
//     a fact about the member's feed, not about what the operator still keeps
//     flagged. (DELETING the template is beyond any spelling here — the FK is
//     ON DELETE SET NULL, so the delete clears the column itself. That is the
//     limit of the legacy arm, and the sharpest argument for D6: a formula has
//     no `feeds` row for anyone to delete.)
//
// `origin_*` is the OTHER question — "you added someone's formula" — so it
// excludes the default seed. Otherwise every new member's first feed would
// carry "from <the operator>'s Starter" as though they had chosen it.
//
// `alias` is interpolated into SQL and is a compile-time literal at every call
// site (the table alias in that query — `f`, or the table name itself inside a
// RETURNING). It never carries user input.
export function feedProvenanceSql(alias: string): string {
  return `(${alias}.cloned_from_feed_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM feed_formulas seed
                  WHERE seed.id = ${alias}.from_formula_id AND seed.is_default_seed)) AS from_starter,
     (SELECT ff.name FROM feed_formulas ff
       WHERE ff.id = ${alias}.from_formula_id AND NOT ff.is_default_seed) AS origin_formula_name,
     (SELECT COALESCE(a.display_name, a.username)
        FROM feed_formulas ff JOIN accounts a ON a.id = ff.author_id
       WHERE ff.id = ${alias}.from_formula_id AND NOT ff.is_default_seed) AS origin_author_name`;
}

// Create a feed for an owner, ranked last (max+1 within the owner's set). A
// concurrent create can tie; ties are fine (read order falls back to
// created_at). Extracted from POST /feeds (FOLLOW-GRAPH-IMPORT-ADR §11.1) so
// the follow-import engine can mint the import's target feed through the same
// path. Returns the full FeedRow (source_count 0 by construction).
//
// It lives HERE rather than in crud.ts (where it was born) because Phase 2 made
// crud.ts a caller of the formula redeem core, and formulas.ts was already a
// caller of this: leaving it in crud.ts would have made the two modules import
// each other. Function-declaration hoisting would have survived that cycle
// today and broken on the first module-init read of the other's binding, which
// is not a trap worth leaving. shared.ts is the module both may depend on.
//
// `opts` serves formula redemption (FEED-FORMULAS-ADR §5): a redeemed feed
// arrives in the author's colour scheme, and carries the formula it came from
// for the D7 attribution line. Both default to today's behaviour — an omitted
// option cannot change what POST /feeds or the import engine mint. `origin_*`
// come back NULL on this path by construction: the JOIN would be against a row
// this INSERT has only just referenced, and the caller (redeem) already holds
// the formula's name and author.
export interface CreateFeedOptions {
  appearance?: Record<string, unknown>;
  fromFormulaId?: string;
}
export async function createFeedForOwner(
  ownerId: string,
  name: string,
  db: { query: typeof pool.query } = pool,
  opts: CreateFeedOptions = {},
): Promise<FeedRow> {
  const { rows } = await db.query<FeedRow>(
    `INSERT INTO feeds (owner_id, name, sort_rank, appearance, from_formula_id)
     VALUES ($1, $2,
       (SELECT COALESCE(MAX(sort_rank), 0) + 1 FROM feeds WHERE owner_id = $1),
       COALESCE($3::jsonb, '{}'::jsonb), $4)
     RETURNING id, name, appearance, sort_rank, hidden, created_at, updated_at, 0::int AS source_count,
       false AS from_starter, NULL::text AS origin_formula_name, NULL::text AS origin_author_name`,
    [
      ownerId,
      name,
      opts.appearance ? JSON.stringify(opts.appearance) : null,
      opts.fromFormulaId ?? null,
    ],
  );
  return rows[0];
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
// muted_at, not weight). feed_sources.weight DEFAULTs to 4.0 = step 5, and
// every add path inherits it (addSource's INSERT omits weight): a source you
// just chose arrives at full volume, deliberately. Do NOT change the schema
// default — weight multiplies live ranking (feed-rank.ts), so a new default
// silently re-ranks every source on the platform, and follow-import's
// post-import sampling guard hard-codes `weight = 4.0` as its "operator has
// not touched this" sentinel (follow-import.ts).
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
