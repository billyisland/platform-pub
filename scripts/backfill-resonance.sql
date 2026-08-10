-- =============================================================================
-- One-off resonance backfill for external items.
--
-- WHY THIS EXISTS. The ongoing scorer only ever runs over the ids whose
-- engagement counts MOVED in that pass (`batchUpdateCounts` →
-- `refreshResonanceFor`, feed-ingest/src/tasks/external-engagement-refresh.ts).
-- That is right for steady state and wrong after any gap in scoring: a row
-- whose counts have settled is never revisited, so it keeps a NULL band
-- forever and the D7 glyph has nothing to draw on it. Found 2026-08-10, when
-- the running feed-ingest image turned out to predate the scorer by one day —
-- 21 days of ingest with not a single band written, and every card silent.
--
-- It is a TRANSCRIPTION of the cron's own SQL (`EXTERNAL_RESONANCE_SQL` +
-- `scoreTail` + `PCTL_EXPR` in feed-ingest/src/lib/resonance.ts), with the
-- driving set widened from "these ids" to "everything unscored in the window".
-- Nothing else differs, and it must stay that way: if the scorer's expressions
-- change, this file is stale and re-running it would write yesterday's maths
-- over today's. Re-read it against resonance.ts before every use.
--
-- The dials are read from platform_config, never hard-coded, so a retuned
-- operator value is honoured (tuning-dials invariant). Defaults mirror
-- shared/src/db/config-defaults.sql for a table with the row missing.
--
-- Safe to re-run: it recomputes derived columns only, touches no money, no
-- ledger and no user content, and is idempotent for a fixed input.
--
--   docker compose exec -T postgres psql -U platformpub -d platformpub \
--     -v ON_ERROR_STOP=1 -f - < scripts/backfill-resonance.sql
--
-- WINDOW: rows with no band yet, published within the interval below. Widen it
-- if a longer gap needs repairing; it is deliberately not unbounded, because a
-- band is a claim about a post's moment and there is little point restating it
-- for items no feed will ever show again.
-- =============================================================================

\set window_interval '\'30 days\''

WITH dials AS (
  SELECT
    COALESCE(MAX(value) FILTER (WHERE key = 'resonance_weight_like'),   '1')   ::numeric AS w_like,
    COALESCE(MAX(value) FILTER (WHERE key = 'resonance_weight_reply'),  '3')   ::numeric AS w_reply,
    COALESCE(MAX(value) FILTER (WHERE key = 'resonance_weight_repost'), '2')   ::numeric AS w_repost,
    COALESCE(MAX(value) FILTER (WHERE key = 'resonance_shrink_k'),      '3')   ::numeric AS k,
    COALESCE(MAX(value) FILTER (WHERE key = 'resonance_band1_min'),     '2.5') ::numeric AS b1,
    COALESCE(MAX(value) FILTER (WHERE key = 'resonance_band2_min'),     '4')   ::numeric AS b2,
    COALESCE(MAX(value) FILTER (WHERE key = 'resonance_band3_min'),     '6')   ::numeric AS b3
  FROM platform_config
),
e AS (
  SELECT fi.id AS feed_item_id,
         fi.external_author_id::text AS author_ref,
         fi.source_protocol AS protocol,
         'all'::text AS post_type,
         (ei.like_count * d.w_like + ei.reply_count * d.w_reply
          + ei.repost_count * d.w_repost)::numeric AS e
  FROM feed_items fi
  JOIN external_items ei ON ei.id = fi.external_item_id
  CROSS JOIN dials d
  WHERE fi.item_type = 'external'
    AND fi.deleted_at IS NULL
    AND fi.resonance_band IS NULL
    AND fi.published_at > now() - :window_interval::interval
),
j AS (
  SELECT e.feed_item_id, e.e, amb.p50_e, amb.p90_e,
         (COALESCE(b.n, 0)::numeric * COALESCE(b.median_e, 0) + d.k * amb.p50_e)
           / NULLIF(COALESCE(b.n, 0)::numeric + d.k, 0) AS baseline
  FROM e
  CROSS JOIN dials d
  -- INNER JOIN, deliberately: a protocol with no ambient row is structurally
  -- silent (rss/email, dark nostr) and its rows must stay NULL. Absence is not
  -- zero — do not "fix" this with a COALESCE.
  JOIN protocol_engagement_ambient amb
    ON amb.protocol = e.protocol AND amb.post_type = e.post_type
  LEFT JOIN author_engagement_baseline b
    ON b.author_ref = e.author_ref
   AND b.protocol = e.protocol
   AND b.post_type = e.post_type
),
r AS (
  SELECT j.*, log(2.0, (1 + j.e) / (1 + COALESCE(j.baseline, 0))) AS resonance
  FROM j
)
UPDATE feed_items fi
SET resonance = r.resonance,
    resonance_band = (
      CASE
        WHEN r.resonance >= d.b3 AND r.e >= r.p90_e THEN 3
        WHEN r.resonance >= d.b2 AND r.e >= r.p50_e THEN 2
        WHEN r.resonance >= d.b1 AND r.e >= r.p50_e THEN 1
        ELSE 0
      END
    )::smallint,
    ambient_pctl = (
      CASE
        WHEN r.e <= 0 THEN 0
        WHEN r.p90_e <= 0 THEN 1.0
        WHEN r.p50_e <= 0 THEN
          CASE
            WHEN r.e >= r.p90_e
              THEN LEAST(1.0, 0.9 + 0.1 * (r.e - r.p90_e) / GREATEST(r.p90_e, 1))
            ELSE 0.5 + 0.4 * r.e / r.p90_e
          END
        WHEN r.e < r.p50_e THEN 0.5 * r.e / r.p50_e
        WHEN r.e < r.p90_e THEN 0.5 + 0.4 * (r.e - r.p50_e) / (r.p90_e - r.p50_e)
        ELSE LEAST(1.0, 0.9 + 0.1 * (r.e - r.p90_e) / GREATEST(r.p90_e, 1))
      END
    )
FROM r CROSS JOIN dials d
WHERE fi.id = r.feed_item_id;
