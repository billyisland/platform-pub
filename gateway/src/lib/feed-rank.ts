import { getPlatformConfig } from "./platform-config.js";

// =============================================================================
// D6 — read-time proof blend for scored feed ranking
// (SOCIAL-PROOF-RESONANCE-ADR D6, sequencing step 5)
//
// Steps 3/4 stored `resonance` / `resonance_band` / `ambient_pctl` on
// feed_items and rendered the band. Nothing RANKED on them. This module is the
// read-time expression that does, replacing the cron-baked `fi.score`
// numerator in the `scored` sampling mode:
//
//   proof_term      = α · resonance_norm + (1 − α) · ambient_pctl
//   resonance_norm  = clamp(resonance, 0, 4) / 4
//   effective_score = proof_term / power(age_hours + 2, gravity) · weight
//
// WHY READ TIME (D6): α is a per-feed-surface product decision, but `fi.score`
// is computed surface-agnostically at cron time — a cron-baked blend could only
// bake one α. And ranking native items on cron gravity scores while external
// items ranked on read-time proof terms would put the two in incommensurable
// units, which is precisely the disease this ADR exists to cure. So when the
// flag is on, EVERY item in scored mode ranks by this one expression.
//
// `fi.score` and feed-scores-refresh's gravity write are untouched — they stay
// the flag-off fallback, so the brake is instantly reversible with no backfill.
// =============================================================================

// Operator brake for the D6 read-time blend (step 5). Default OFF, gating the
// one place the blend is spliced in (the `scored` CTE in feeds/items.ts) — the
// same narrowest-choke-point discipline as RESONANCE_GLYPH_ENABLED. Ranking is
// wholly server-side, so there is no web twin to keep in sync.
//
// The two brakes are INDEPENDENT on purpose: ranking on resonance and showing
// the band are separate claims with separate evidence bars, so an A/B of the
// explore feed can run with the glyph still dark.
export function resonanceRankingEnabled(): boolean {
  const v = process.env.RESONANCE_RANKING_ENABLED;
  return v === "1" || v === "true";
}

export interface ProofBlendParams {
  /** α on a feed with no explore reach source — "a moment for this writer". */
  alphaFollowing: number;
  /** α on a feed carrying a reach:explore source — "big on the network". */
  alphaExplore: number;
  /** HN-style time-decay exponent. Shared with feed-scores-refresh (same family). */
  gravity: number;
  /** Floor under proof_term so zero-proof items still order by recency (see below). */
  floor: number;
}

// Defaults mirror migrations 158/161 so a DB missing the rows (a fresh boot
// from schema.sql, which is schema-only and carries no platform_config seed)
// behaves identically to a seeded one.
const DEFAULTS: ProofBlendParams = {
  alphaFollowing: 0.8,
  alphaExplore: 0.4,
  gravity: 1.5,
  floor: 0.05,
};

export async function loadProofBlendParams(): Promise<ProofBlendParams> {
  const config = await getPlatformConfig();
  const num = (key: string, fallback: number) => {
    const v = parseFloat(config.get(key) ?? "");
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    alphaFollowing: num("feed_alpha_following", DEFAULTS.alphaFollowing),
    alphaExplore: num("feed_alpha_explore", DEFAULTS.alphaExplore),
    // Deliberately the SAME key feed-scores-refresh uses: both are feed-ranking
    // time decay, one family, one dial. (Contrast the resonance_* weights,
    // which are namespaced away from feed_weight_* precisely so tuning hotness
    // never moves every author's baseline.)
    gravity: num("feed_gravity", DEFAULTS.gravity),
    floor: num("feed_proof_floor", DEFAULTS.floor),
  };
}

/**
 * The per-feed α, as a scalar CTE. Splice into the host query's WITH list.
 *
 * α is chosen from the feed's own composition rather than a stored column: a
 * feed carrying a non-muted `reach:explore` source IS the explore surface, and
 * anything else is a following-shaped surface. That keeps the surface decision
 * derived from what the user actually composed, with no third place to fall out
 * of sync (`$aExplore`/`$aFollowing` are the two bound params).
 */
export function feedAlphaCte(feedIdParam: number, aExplore: number, aFollowing: number): string {
  return `
    feed_alpha AS (
      SELECT (CASE WHEN EXISTS (
        SELECT 1 FROM feed_sources
         WHERE feed_id = $${feedIdParam} AND muted_at IS NULL
           AND source_type = 'reach' AND reach_kind = 'explore'
      ) THEN $${aExplore}::float8 ELSE $${aFollowing}::float8 END) AS alpha
    )`;
}

/**
 * The D6 effective_score expression, for splicing into the `scored` CTE in
 * place of `COALESCE(fi.score, 0) * m.weight`. Requires `feed_alpha` (above) in
 * the host query's WITH list, `fi` bound to feed_items, and `m.weight`.
 *
 * ABSENCE HANDLING — a correction to D6 as drafted. The ADR says NULL-band
 * items (rss/email, dark nostr) "take proof_term = 0 and rank on recency alone
 * within the gravity expression". They cannot: 0 / (age+2)^g is 0 for every
 * age, so a proof_term of exactly 0 collapses every silent item to one constant
 * score and the ORDER BY falls through to the uuid tiebreak — arbitrary order,
 * not recency. A silent protocol would rank by random uuid, which is worse than
 * the chronology it replaced. So proof_term carries a small FLOOR: silent items
 * keep a positive numerator, order among themselves by age exactly as intended,
 * and still sit below any item with real proof. The floor is a config dial
 * (`feed_proof_floor`, migration 161), not a constant — it trades off how far a
 * silent-but-fresh item can outrank a resonant-but-older one.
 *
 * Both stored inputs are clamped here rather than trusted: `resonance` is
 * unbounded above (log2 of an arbitrary ratio) and negative below (E under
 * baseline), and `ambient_pctl` should be in [0,1] but is a plain NUMERIC. A
 * bad row must not be able to dominate the ordering of a whole feed.
 */
export function proofBlendScoreSql(gravityParam: number, floorParam: number): string {
  return `(
    GREATEST(
        (SELECT alpha FROM feed_alpha)
          * LEAST(GREATEST(COALESCE(fi.resonance, 0)::float8, 0), 4) / 4
      + (1 - (SELECT alpha FROM feed_alpha))
          * LEAST(GREATEST(COALESCE(fi.ambient_pctl, 0)::float8, 0), 1),
      $${floorParam}::float8
    )
    / POWER(
        GREATEST(EXTRACT(EPOCH FROM (now() - fi.published_at)) / 3600, 0) + 2,
        $${gravityParam}::float8
      )
  )::float8 * m.weight`;
}
