-- Migration 022: Add composite index on read_events (reader_id, article_id)
--
-- The payment verification query in key-service filters by (reader_id, article_id, state).
-- Individual indexes exist on reader_id and article_id but no composite.
-- This index covers the verification lookup path directly.
--
-- Note: uses plain CREATE INDEX (not CONCURRENTLY) because the migration runner
-- wraps each migration in a transaction, and CONCURRENTLY cannot run inside one.

CREATE INDEX IF NOT EXISTS idx_read_events_reader_article
  ON read_events (reader_id, article_id);
