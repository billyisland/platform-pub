-- =============================================================================
-- 001: Add email + magic link auth
--
-- The accounts table in the base schema has no email column — the original
-- design assumed Nostr-native auth. For the hosted platform launch, we need
-- email-based passwordless login (magic links).
--
-- Also creates the magic_links table for token tracking.
-- =============================================================================

-- Add email to accounts
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts (email) WHERE email IS NOT NULL;

-- Magic link tokens
-- Each token is single-use, expires after 15 minutes.
-- The token itself is a 32-byte random value, stored as hex.
CREATE TABLE IF NOT EXISTS magic_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,   -- SHA-256 hash of the token (never store raw)
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,            -- NULL = unused
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_magic_links_token_hash ON magic_links (token_hash) WHERE used_at IS NULL;
CREATE INDEX idx_magic_links_expires ON magic_links (expires_at) WHERE used_at IS NULL;
