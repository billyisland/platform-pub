-- =============================================================================
-- 089: workspace hardening — tag name constraint + feed_sources query index
--
-- (5) feed_sources.tag_name has a 1–64 char limit in the API schema (Zod) but
-- no DB constraint. Add a CHECK so the DB is the last line of defence.
--
-- (7) The sourceFilteredItems feed_mode CTE filters feed_sources on
-- (feed_id, muted_at IS NULL). The existing feed_sources_feed_idx covers
-- feed_id but not the muted_at predicate. A partial index on non-muted rows
-- lets the planner skip muted sources without a filter step.
-- =============================================================================

ALTER TABLE feed_sources
  ADD CONSTRAINT feed_sources_tag_name_length
  CHECK (tag_name IS NULL OR char_length(tag_name) BETWEEN 1 AND 64);

CREATE INDEX feed_sources_feed_active_idx
  ON feed_sources (feed_id, sampling_mode)
  WHERE muted_at IS NULL;
