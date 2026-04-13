-- =============================================================================
-- 052: Universal Feed — External Sources, Subscriptions & Items
--
-- Phase 1 of the Universal Feed ADR. Creates the external content pipeline
-- tables: external_sources (canonical feeds/accounts), external_subscriptions
-- (user-to-source), external_items (normalised foreign content). Also seeds
-- platform_config with ingestion tuning parameters.
--
-- Does NOT create feed_items (Phase 2), linked_accounts, outbound_posts, or
-- oauth_app_registrations (Phase 5).
-- =============================================================================

-- New enum: external protocol types
CREATE TYPE external_protocol AS ENUM (
  'atproto',
  'activitypub',
  'rss',
  'nostr_external'
);

-- =============================================================================
-- external_sources — canonical external accounts/feeds
--
-- Each row represents one unique external source. Shared across all
-- subscribers: if 50 users follow the same Bluesky account, there is one
-- external_sources row and one set of external_items.
-- =============================================================================

CREATE TABLE external_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol        external_protocol NOT NULL,

  -- Canonical source identifier (protocol-specific)
  --   atproto:        DID (e.g. did:plc:abc123...)
  --   activitypub:    Actor URI (e.g. https://mastodon.social/users/alice)
  --   rss:            Feed URL (e.g. https://example.com/feed.xml)
  --   nostr_external: Hex pubkey
  source_uri      TEXT NOT NULL,

  -- Display metadata (cached from source, refreshed periodically)
  display_name    TEXT,
  avatar_url      TEXT,
  description     TEXT,

  -- Relay hints (nostr_external only)
  relay_urls      TEXT[],

  -- Polling / sync state (owned by the ingestion worker)
  last_fetched_at TIMESTAMPTZ,
  cursor          TEXT,
  fetch_interval_seconds INT NOT NULL DEFAULT 300,
  error_count     INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_source UNIQUE (protocol, source_uri)
);

CREATE INDEX idx_ext_sources_protocol   ON external_sources(protocol) WHERE is_active = TRUE;
CREATE INDEX idx_ext_sources_next_fetch ON external_sources(last_fetched_at)
  WHERE is_active = TRUE;

-- =============================================================================
-- external_subscriptions — user-to-source subscriptions
-- =============================================================================

CREATE TABLE external_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,

  -- Per-subscription preferences
  is_muted      BOOLEAN NOT NULL DEFAULT FALSE,
  daily_cap     INT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_subscription UNIQUE (subscriber_id, source_id)
);

CREATE INDEX idx_ext_subs_subscriber ON external_subscriptions(subscriber_id);
CREATE INDEX idx_ext_subs_source     ON external_subscriptions(source_id);

-- =============================================================================
-- external_items — normalised foreign content
--
-- Every ingested post, toot, skeet, or RSS entry becomes one row. Shared
-- across subscribers — items belong to a source, not to an individual user.
-- =============================================================================

CREATE TABLE external_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  protocol          external_protocol NOT NULL,
  tier              content_tier NOT NULL,

  CONSTRAINT protocol_tier_consistency CHECK (
    (protocol = 'nostr_external' AND tier = 'tier2') OR
    (protocol IN ('atproto', 'activitypub') AND tier = 'tier3') OR
    (protocol = 'rss' AND tier = 'tier4')
  ),

  -- Origin identity
  source_item_uri   TEXT NOT NULL,

  -- Author (may differ from source owner, e.g. repost/boost)
  author_name       TEXT,
  author_handle     TEXT,
  author_avatar_url TEXT,
  author_uri        TEXT,

  -- Normalised content
  content_text      TEXT,
  content_html      TEXT,
  summary           TEXT,
  title             TEXT,
  language          TEXT,

  -- Media attachments (JSONB array)
  media             JSONB DEFAULT '[]',

  -- Embeds and references
  source_reply_uri  TEXT,
  source_quote_uri  TEXT,
  is_repost         BOOLEAN NOT NULL DEFAULT FALSE,
  original_item_uri TEXT,

  -- Interaction metadata (for outbound reply routing)
  interaction_data  JSONB DEFAULT '{}',

  -- Timestamps
  published_at      TIMESTAMPTZ NOT NULL,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Deletion tracking
  deleted_at        TIMESTAMPTZ,

  -- Deduplication
  CONSTRAINT unique_source_item UNIQUE (protocol, source_item_uri)
);

CREATE INDEX idx_ext_items_source_id    ON external_items(source_id);
CREATE INDEX idx_ext_items_published_at ON external_items(published_at DESC);
CREATE INDEX idx_ext_items_author_uri   ON external_items(author_uri);
CREATE INDEX idx_ext_items_source_reply ON external_items(source_reply_uri)
  WHERE source_reply_uri IS NOT NULL;

-- =============================================================================
-- platform_config — feed ingestion tuning parameters
-- =============================================================================

INSERT INTO platform_config (key, value, description) VALUES
  ('feed_ingest_rss_interval_seconds',     '300',  'Default RSS polling interval (5 min)'),
  ('feed_ingest_rss_min_interval_seconds', '60',   'Minimum RSS polling interval'),
  ('feed_ingest_ap_interval_seconds',      '120',  'Default ActivityPub outbox polling interval'),
  ('feed_ingest_max_items_per_fetch',      '50',   'Max items to ingest per poll cycle'),
  ('feed_ingest_error_backoff_factor',     '2',    'Exponential backoff multiplier on fetch errors'),
  ('feed_ingest_max_error_count',          '10',   'Deactivate source after N consecutive errors'),
  ('feed_ingest_daily_cap_default',        '100',  'Default max items/day per source (safety valve)'),
  ('feed_ingest_max_per_host',             '2',    'Max concurrent fetch jobs per hostname'),
  ('feed_ingest_max_concurrent',           '10',   'Global max concurrent fetch jobs'),
  ('outbound_max_retries',                 '3',    'Max retry attempts for outbound cross-posts'),
  ('outbound_retry_delay_seconds',         '30',   'Base delay between outbound retries'),
  ('external_items_retention_days',        '90',   'Days to retain external items before pruning'),
  ('max_subscriptions_per_user',           '200',  'Max external source subscriptions per user');
