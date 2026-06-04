-- 104_repost_edges_boosted_at.sql
-- Feed-ingest/hydration audit Tranche A (A3 + A4): scope the repost-graph reads.
--
-- The post-feed boost CTE (gateway/src/routes/post-feed.ts) is now bounded both
-- ways: a semijoin to the candidate post_ids AND a recency window
-- (boosted_at > now - 5×half-life). The per-Post attribution fetch
-- (fetchAttribution) takes the most-recent 25 edges per post via a LATERAL.
-- Both want (target_post_id, boosted_at): equality on the leading column +
-- ordered/range scan on boosted_at.
--
-- The composite's leading prefix fully covers the old single-column
-- idx_repost_edges_target (used for `target_post_id = ANY(...)` equality), so
-- that index is now redundant and is dropped to save write/maintenance cost.

CREATE INDEX idx_repost_edges_target_boosted
  ON repost_edges (target_post_id, boosted_at);

DROP INDEX IF EXISTS idx_repost_edges_target;
