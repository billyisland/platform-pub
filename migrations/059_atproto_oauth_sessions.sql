-- =============================================================================
-- 059: Phase 5B — AT Protocol OAuth session storage
--
-- The @atproto/oauth-client-node SimpleStore needs a key→value store for
-- NodeSavedSession records (TokenSet + DPoP key per linked Bluesky account).
-- These records are mutated by every refresh and consumed by every outbound
-- API call, so they must be shared between the gateway (which authorises)
-- and feed-ingest (which posts and refreshes). A dedicated table — keyed by
-- the AT Protocol DID — keeps the OAuth library's bookkeeping isolated from
-- linked_accounts (which holds the user-facing identity row).
--
-- session_data_enc holds the AES-256-GCM encrypted JSON of NodeSavedSession.
-- The encryption key is LINKED_ACCOUNT_KEY_HEX, same as linked_accounts.
-- =============================================================================

CREATE TABLE atproto_oauth_sessions (
  did              TEXT PRIMARY KEY,
  session_data_enc TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
