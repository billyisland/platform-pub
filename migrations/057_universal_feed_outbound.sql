-- =============================================================================
-- 057: Universal Feed Phase 5 — Outbound reply router
--
-- Per ADR §IV.6–§IV.8:
--   linked_accounts         — per-user OAuth credentials for external platforms
--   outbound_posts          — audit/retry log for cross-posted content
--   oauth_app_registrations — per-instance app credentials (Mastodon dyn reg)
--
-- Credentials (client_secret, access/refresh tokens) are stored encrypted at
-- rest with LINKED_ACCOUNT_KEY_HEX (AES-256-GCM via shared/src/lib/crypto.ts),
-- following the same pattern as accounts.nostr_privkey_enc.
-- =============================================================================

CREATE TABLE linked_accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  protocol           external_protocol NOT NULL,

  -- Identity on the external platform
  external_id        TEXT NOT NULL,     -- DID (atproto) / acct id (activitypub) / pubkey (nostr)
  external_handle    TEXT,              -- human-readable handle for UI
  instance_url       TEXT,              -- Mastodon instance base URL; NULL otherwise

  -- Credentials (AES-256-GCM ciphertext)
  credentials_enc    TEXT,

  -- Token lifecycle
  token_expires_at   TIMESTAMPTZ,
  last_refreshed_at  TIMESTAMPTZ,
  is_valid           BOOLEAN NOT NULL DEFAULT TRUE,

  -- User preferences
  cross_post_default BOOLEAN NOT NULL DEFAULT TRUE,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_linked_identity UNIQUE (account_id, protocol, external_id)
);

CREATE INDEX idx_linked_accounts_account ON linked_accounts(account_id);
CREATE INDEX idx_linked_accounts_refresh ON linked_accounts(token_expires_at)
  WHERE is_valid = TRUE AND credentials_enc IS NOT NULL;

-- =============================================================================
-- outbound_posts — one row per cross-post attempt
-- =============================================================================

CREATE TABLE outbound_posts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  linked_account_id UUID NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
  protocol          external_protocol NOT NULL,

  -- The native all.haus event we're cross-posting
  nostr_event_id    TEXT NOT NULL,
  action_type       TEXT NOT NULL
                    CHECK (action_type IN ('reply', 'quote', 'repost', 'original')),

  -- The external item being responded to (NULL for a top-level original post)
  source_item_id    UUID REFERENCES external_items(id) ON DELETE SET NULL,

  -- Outgoing payload and result
  body_text         TEXT,               -- what we actually posted (post-transform)
  external_post_uri TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed', 'retrying')),
  error_message     TEXT,
  retry_count       INT NOT NULL DEFAULT 0,
  max_retries       INT NOT NULL DEFAULT 3,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ
);

CREATE INDEX idx_outbound_posts_account ON outbound_posts(account_id);
CREATE INDEX idx_outbound_posts_pending ON outbound_posts(status)
  WHERE status IN ('pending', 'retrying');
CREATE INDEX idx_outbound_posts_linked  ON outbound_posts(linked_account_id);

-- =============================================================================
-- oauth_app_registrations — per-instance Mastodon app credentials
--
-- Mastodon requires dynamic client registration per instance. The resulting
-- client_id / client_secret are app-level, reused across all users on that
-- instance. Keeping them separate from linked_accounts avoids registering a
-- new app for every user.
-- =============================================================================

CREATE TABLE oauth_app_registrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol          external_protocol NOT NULL,
  instance_url      TEXT NOT NULL,

  client_id         TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,   -- AES-256-GCM ciphertext
  scopes            TEXT,
  redirect_uri      TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_app_registration UNIQUE (protocol, instance_url)
);

-- =============================================================================
-- platform_config — outbound tuning
--
-- `outbound_max_retries` and `outbound_retry_delay_seconds` were seeded in
-- migration 052; adding token-refresh window + text truncation budgets here.
-- =============================================================================

INSERT INTO platform_config (key, value, description) VALUES
  ('outbound_token_refresh_window_pct', '80',
    'Refresh OAuth tokens once elapsed lifetime exceeds this percent of expiry'),
  ('outbound_bluesky_max_graphemes',    '300',
    'Bluesky post graph­eme limit; replies longer are truncated with an all.haus link'),
  ('outbound_mastodon_max_chars',       '500',
    'Default Mastodon status length; replies longer are truncated with an all.haus link')
ON CONFLICT (key) DO NOTHING;
