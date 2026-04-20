-- =============================================================================
-- 074: trigram GIN indexes on accounts.username + accounts.display_name
--
-- searchPlatform() in the universal resolver does
--   WHERE username ILIKE '%foo%' OR display_name ILIKE '%foo%'
-- The leading wildcard means btree can't help and every free-text query was
-- a full sequential scan over accounts. With pg_trgm + GIN, ILIKE on either
-- column is index-backed for queries with at least 3 characters of overlap.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_accounts_username_trgm
  ON accounts USING gin (username gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_accounts_display_name_trgm
  ON accounts USING gin (display_name gin_trgm_ops)
  WHERE display_name IS NOT NULL;
