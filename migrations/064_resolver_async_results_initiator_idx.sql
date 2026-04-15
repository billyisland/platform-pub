-- =============================================================================
-- Migration 064: (initiator_id, created_at DESC) index on resolver_async_results
--
-- Supports the per-initiator row cap enforced in storeAsyncResult() — a
-- spammy client can otherwise create thousands of rows between 5-min prune
-- cycles. The cap query looks up the Nth-newest row per initiator; without
-- this index it falls back to a seq scan keyed off the existing expires_at
-- index (unhelpful for per-initiator ordering).
-- =============================================================================

CREATE INDEX IF NOT EXISTS resolver_async_results_initiator_created_idx
  ON resolver_async_results(initiator_id, created_at DESC);
