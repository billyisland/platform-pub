-- =============================================================================
-- 061: DB-backed resolver async results (replaces per-replica in-memory Map)
--
-- Phase B of the universal resolver kicks off out-of-band remote lookups
-- (WebFinger, NIP-05, atproto AppView, RSS discovery) and stores the completed
-- result for the caller to poll via GET /resolve/:requestId. Storing this in a
-- process-local Map breaks once the gateway scales out: the poll hits a
-- different replica than the one that ran the initial resolve and returns 404.
--
-- Binding each row to its initiator also closes the S4 audit finding — a leaked
-- requestId can't be used by another account to fetch someone else's emails,
-- handles, or profile metadata; the GET handler rejects initiator mismatches
-- with a 404.
--
-- Rows are short-lived (TTL ~60s); a lightweight cron prunes expired entries.
-- =============================================================================

CREATE TABLE resolver_async_results (
  request_id   UUID PRIMARY KEY,
  initiator_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  result       JSONB NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX resolver_async_results_expires_at_idx
  ON resolver_async_results(expires_at);
