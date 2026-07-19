import type { Task } from "graphile-worker";
import type { PoolClient } from "pg";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { getPlatformConfig } from "../lib/platform-config.js";

// =============================================================================
// engagement_baseline_refresh — daily author baselines + network ambient
// (SOCIAL-PROOF-RESONANCE-ADR D3, revised: recompute, don't fold)
//
// Rebuilds author_engagement_baseline and protocol_engagement_ambient from
// scratch each run. Deliberately NOT incremental: a true median can't be
// updated from (median, n) alone, and the <7d daily engagement sweep touches
// each item ~6 times, so fold-on-write would multiple-count posts into the
// baseline. Recompute is idempotent, self-healing after any refresh outage,
// and gives the D5 lag guarantee structurally — only posts >48h old (near-final
// E) enter a baseline, so a surging post is always measured against the
// author's PRIOR expectation, never against itself.
//
// Per-post E (weights from platform_config, resonance_* keys — see 158):
//   external: like·w_like + reply·w_reply + repost·w_repost
//             from external_items' denormalised counts (lifetime, monotonic
//             for nostr). nostr_external only when
//             NOSTR_ENGAGEMENT_COUNTS_ENABLED — dark rows would poison
//             baselines with zeros.
//   native:   up_votes·w_up + gate_passes·w_gate + replies·w_reply
//             from votes / read_events / feed_engagement (lifetime).
//             Down-votes never subtract (D2: valence is a separate axis).
//             Native reposts: not yet recorded for native targets
//             (repost-edge.ts "bind lazily") — weight seeded, term absent.
//
// Baseline = median E over the author's last ≤20 qualifying posts. Shrinkage
// toward ambient happens at SCORE time in the refresh crons
// ((n·median + k·p50)/(n + k)), not here — the table stores the raw estimate.
//
// Bounds: 180-day sample window (external_items are pruned anyway; native is
// bounded for the same reason — ancient posts shouldn't drag a baseline), one
// connection, temp tables, ~6 statements. Runs after the 04:00 UTC daily
// engagement sweep so it sees that run's counts.
// =============================================================================

const SAMPLE_WINDOW_DAYS = 180;
const BASELINE_MIN_AGE_HOURS = 48; // posts younger than this have partial E
const BASELINE_LAST_N = 20;
const STALE_BASELINE_DAYS = 30; // authors gone from the window age out

function nostrEngagementEnabled(): boolean {
  const v = process.env.NOSTR_ENGAGEMENT_COUNTS_ENABLED;
  return v === "1" || v === "true";
}

interface ResonanceWeights {
  like: number;
  reply: number;
  repost: number;
  nativeUp: number;
  nativeGate: number;
}

async function loadWeights(): Promise<ResonanceWeights> {
  const config = await getPlatformConfig();
  const num = (key: string, fallback: number) => {
    const v = parseFloat(config.get(key) ?? "");
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    like: num("resonance_weight_like", 1),
    reply: num("resonance_weight_reply", 3),
    repost: num("resonance_weight_repost", 2),
    nativeUp: num("resonance_weight_native_up", 5),
    nativeGate: num("resonance_weight_native_gate", 5),
  };
}

export const engagementBaselineRefresh: Task = async () => {
  const w = await loadWeights();
  const client = await pool.connect();
  try {
    // One transaction: the temp table is ON COMMIT DROP, and under autocommit
    // it would vanish after its own CREATE statement.
    await client.query("BEGIN");
    await refresh(client, w);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

async function refresh(client: PoolClient, w: ResonanceWeights): Promise<void> {
  const externalProtocols = nostrEngagementEnabled()
    ? ["atproto", "activitypub", "nostr_external"]
    : ["atproto", "activitypub"];

  // ── per-post E, external ──────────────────────────────────────────────────
  // Driven from feed_items (which carries external_author_id — external_items
  // doesn't); context-only rows are thread scaffolding, not the author's output.
  await client.query(
    `
    CREATE TEMP TABLE tmp_e ON COMMIT DROP AS
    SELECT
      fi.external_author_id::text AS author_ref,
      fi.source_protocol          AS protocol,
      'all'::text                 AS post_type,
      ei.published_at,
      (ei.like_count * $1 + ei.reply_count * $2 + ei.repost_count * $3)::numeric AS e
    FROM feed_items fi
    JOIN external_items ei ON ei.id = fi.external_item_id
    WHERE fi.item_type = 'external'
      AND fi.external_author_id IS NOT NULL
      AND fi.deleted_at IS NULL
      AND ei.deleted_at IS NULL
      AND ei.is_context_only = false
      AND ei.protocol::text = ANY($4)
      AND ei.published_at < now() - make_interval(hours => $5)
      AND ei.published_at > now() - make_interval(days => $6)
    `,
    [
      w.like,
      w.reply,
      w.repost,
      externalProtocols,
      BASELINE_MIN_AGE_HOURS,
      SAMPLE_WINDOW_DAYS,
    ],
  );

  // ── per-post E, native ────────────────────────────────────────────────────
  // Lifetime counts per post (matching external semantics — the 48h window
  // belongs to hotness, not resonance). Gate passes exclude charged_back but
  // include free-allowance reads: a gate pass is an attention signal here,
  // money is a separate future axis (D8).
  await client.query(
    `
    INSERT INTO tmp_e (author_ref, protocol, post_type, published_at, e)
    SELECT
      p.author_id::text, 'native', p.post_type, p.published_at,
      (COALESCE(v.up, 0) * $1 + COALESCE(g.passes, 0) * $2 + COALESCE(r.replies, 0) * $3)::numeric
    FROM (
      SELECT a.writer_id AS author_id, 'article'::text AS post_type, a.published_at,
             a.nostr_event_id, a.id AS article_id
      FROM articles a
      WHERE a.deleted_at IS NULL AND a.published_at IS NOT NULL
      UNION ALL
      SELECT n.author_id, 'note', n.published_at, n.nostr_event_id, NULL
      FROM notes n
      WHERE n.published_at IS NOT NULL
    ) p
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS up FROM votes
      WHERE target_nostr_event_id = p.nostr_event_id AND direction = 'up'
    ) v ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS passes FROM read_events
      WHERE article_id = p.article_id AND state <> 'charged_back'
    ) g ON p.article_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS replies FROM feed_engagement
      WHERE target_nostr_event_id = p.nostr_event_id AND engagement_type = 'reply'
    ) r ON true
    WHERE p.published_at < now() - make_interval(hours => $4)
      AND p.published_at > now() - make_interval(days => $5)
    `,
    [w.nativeUp, w.nativeGate, w.reply, BASELINE_MIN_AGE_HOURS, SAMPLE_WINDOW_DAYS],
  );

  // ── network ambient (D4 veto + D3 shrinkage prior) ────────────────────────
  const ambient = await client.query(
    `
    INSERT INTO protocol_engagement_ambient (protocol, post_type, p50_e, p90_e, sample_n, updated_at)
    SELECT protocol, post_type,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY e),
           percentile_cont(0.9) WITHIN GROUP (ORDER BY e),
           COUNT(*), now()
    FROM tmp_e
    GROUP BY protocol, post_type
    ON CONFLICT (protocol, post_type) DO UPDATE SET
      p50_e = EXCLUDED.p50_e,
      p90_e = EXCLUDED.p90_e,
      sample_n = EXCLUDED.sample_n,
      updated_at = EXCLUDED.updated_at
    `,
  );

  // ── author baselines: median over last ≤20 qualifying posts ───────────────
  const baselines = await client.query(
    `
    WITH ranked AS (
      SELECT author_ref, protocol, post_type, e,
             row_number() OVER (
               PARTITION BY author_ref, protocol, post_type
               ORDER BY published_at DESC
             ) AS rn
      FROM tmp_e
    )
    INSERT INTO author_engagement_baseline (author_ref, protocol, post_type, median_e, n, updated_at)
    SELECT author_ref, protocol, post_type,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY e),
           COUNT(*), now()
    FROM ranked
    WHERE rn <= $1
    GROUP BY author_ref, protocol, post_type
    ON CONFLICT (author_ref, protocol, post_type) DO UPDATE SET
      median_e = EXCLUDED.median_e,
      n = EXCLUDED.n,
      updated_at = EXCLUDED.updated_at
    `,
    [BASELINE_LAST_N],
  );

  // Authors with no qualifying posts in the window age out rather than pinning
  // a stale expectation forever. (Their items fall back to pure-ambient
  // scoring via n=0 shrinkage — same as a new author, which is what they are
  // again after 6 silent months.)
  const pruned = await client.query(
    `DELETE FROM author_engagement_baseline
     WHERE updated_at < now() - make_interval(days => $1)`,
    [STALE_BASELINE_DAYS],
  );

  logger.info(
    {
      ambientRows: ambient.rowCount,
      authorBaselines: baselines.rowCount,
      prunedBaselines: pruned.rowCount,
      nostrIncluded: nostrEngagementEnabled(),
    },
    "engagement baseline refresh complete",
  );
}
