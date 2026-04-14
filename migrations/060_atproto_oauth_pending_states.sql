-- =============================================================================
-- 060: Phase 5B — DB-backed atproto OAuth pending state store
--
-- The @atproto/oauth-client-node flow stores a short-lived NodeSavedState
-- record (PKCE verifier + DPoP key) between authorize() and the OAuth callback.
-- Replacing the per-process Map with a DB-backed store means the authorize
-- request and the callback can be handled by different gateway replicas behind
-- a load balancer — otherwise ~50% of Bluesky connections would fail once the
-- gateway scales out.
--
-- Rows have a 10-minute TTL; a feed-ingest cron cleans up expired entries.
-- state_data_enc is AES-256-GCM encrypted with LINKED_ACCOUNT_KEY_HEX.
-- =============================================================================

CREATE TABLE atproto_oauth_pending_states (
  key             TEXT PRIMARY KEY,
  state_data_enc  TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX atproto_oauth_pending_states_expires_at_idx
  ON atproto_oauth_pending_states(expires_at);
