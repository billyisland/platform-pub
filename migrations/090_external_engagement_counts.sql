-- Migration 090: Add engagement count columns to external_items
--
-- Workspace Full View Phase 1: denormalised engagement counts for
-- Compact/Full fidelity rendering. Populated at ingest time and
-- refreshed periodically by the external_engagement_refresh task.

ALTER TABLE external_items ADD COLUMN like_count   INT NOT NULL DEFAULT 0;
ALTER TABLE external_items ADD COLUMN reply_count  INT NOT NULL DEFAULT 0;
ALTER TABLE external_items ADD COLUMN repost_count INT NOT NULL DEFAULT 0;
