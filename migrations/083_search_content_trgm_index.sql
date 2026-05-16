-- CONCURRENTLY removed: runner wraps each migration in BEGIN/COMMIT,
-- and CONCURRENTLY cannot run inside a transaction block.
-- For production, apply this migration manually outside the runner.
CREATE INDEX IF NOT EXISTS idx_articles_content_free_trgm
  ON articles USING gin (content_free gin_trgm_ops);
