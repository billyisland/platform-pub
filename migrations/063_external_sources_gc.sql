-- =============================================================================
-- Migration 063: external_sources orphaned_at + GC column
--
-- Records when an external_sources row lost its last subscriber so a daily
-- GC task can first deactivate (grace window) and later hard-delete (cull
-- window) feeds nobody follows. Without this, every churned subscription
-- leaves a source behind that the poll cron keeps fetching forever.
--
-- The subscribe path's ON CONFLICT upsert clears orphaned_at and flips
-- is_active back to TRUE, so a re-subscribe within the grace window
-- resurrects the source with its item history intact.
-- =============================================================================

ALTER TABLE external_sources
  ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ext_sources_orphaned
  ON external_sources(orphaned_at)
  WHERE orphaned_at IS NOT NULL;
