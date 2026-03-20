-- =============================================================================
-- platform.pub — PostgreSQL Schema
-- Derived from ADR Draft v0.7 (13 March 2026)
-- =============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- full-text trigram search indexes

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE read_state AS ENUM (
  'provisional',       -- on free allowance; no card connected
  'accrued',           -- card connected; tab running; not yet settled
  'platform_settled',  -- reader's card charged; platform holds funds
  'writer_paid'        -- transferred to writer via Stripe Connect
);

CREATE TYPE content_type AS ENUM (
  'note',              -- kind 1, short-form, free
  'article'            -- NIP-23 kind 30023, long-form, monetisable
);

CREATE TYPE content_tier AS ENUM (
  'tier1',             -- native platform content
  'tier2',             -- federated Nostr content
  'tier3',             -- bridged fediverse (Mostr) — post-launch
  'tier4'              -- external RSS — post-launch
);

CREATE TYPE account_status AS ENUM (
  'active',
  'suspended',
  'moderated'          -- content removed from surface; identity intact
);

CREATE TYPE payout_status AS ENUM (
  'pending',           -- below £20 threshold or Stripe KYC incomplete
  'initiated',         -- Stripe Connect transfer initiated
  'completed',         -- funds reached writer's bank
  'failed'
);

CREATE TYPE report_category AS ENUM (
  'illegal_content',
  'harassment',
  'spam',
  'other'
);

CREATE TYPE report_status AS ENUM (
  'open',
  'under_review',
  'resolved_removed',
  'resolved_no_action'
);

-- =============================================================================
-- ACCOUNTS
-- Covers both writers and readers (a user can be both).
-- =============================================================================

CREATE TABLE accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nostr_pubkey          TEXT NOT NULL UNIQUE,   -- hex-encoded 32-byte pubkey
  nostr_privkey_enc     TEXT,                   -- custodially managed, encrypted at rest; NULL for self-custodied users
  username              TEXT UNIQUE,
  display_name          TEXT,
  bio                   TEXT,
  avatar_blossom_url    TEXT,
  is_writer             BOOLEAN NOT NULL DEFAULT FALSE,
  is_reader             BOOLEAN NOT NULL DEFAULT TRUE,
  status                account_status NOT NULL DEFAULT 'active',
  stripe_customer_id    TEXT UNIQUE,            -- Stripe customer ID for readers
  stripe_connect_id     TEXT UNIQUE,            -- Stripe Connect account ID for writers
  stripe_connect_kyc_complete BOOLEAN NOT NULL DEFAULT FALSE,
  hosting_type          TEXT NOT NULL DEFAULT 'hosted' CHECK (hosting_type IN ('hosted', 'self_hosted')),
  self_hosted_relay_url TEXT,                   -- populated for self-hosted writers
  free_allowance_remaining_pence INT NOT NULL DEFAULT 500,  -- £5.00 in pence
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_accounts_nostr_pubkey ON accounts (nostr_pubkey);
CREATE INDEX idx_accounts_username ON accounts (username);
CREATE INDEX idx_accounts_is_writer ON accounts (is_writer) WHERE is_writer = TRUE;

-- =============================================================================
-- ARTICLES
-- Mirrors NIP-23 kind 30023 events. One row per published article version.
-- The Nostr relay holds the canonical events; this table is the app-layer index.
-- =============================================================================

CREATE TABLE articles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  writer_id             UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,

  -- Nostr identifiers
  nostr_event_id        TEXT NOT NULL UNIQUE,   -- hex event ID of the NIP-23 event
  nostr_d_tag           TEXT NOT NULL,          -- stable addressable identifier
  nostr_kind            INT NOT NULL DEFAULT 30023,

  -- Content
  title                 TEXT NOT NULL,
  slug                  TEXT NOT NULL,
  summary               TEXT,
  content_free          TEXT,                   -- plaintext free section (pre-gate)
  word_count            INT,
  tier                  content_tier NOT NULL DEFAULT 'tier1',

  -- Paywall
  is_paywalled          BOOLEAN NOT NULL DEFAULT FALSE,
  price_pence           INT,                    -- NULL = free; price in pence
  gate_position_pct     INT CHECK (gate_position_pct BETWEEN 1 AND 99), -- default 50
  vault_event_id        TEXT UNIQUE,            -- Nostr event ID of kind 39701 vault

  -- Comments
  comments_enabled      BOOLEAN NOT NULL DEFAULT TRUE,

  -- Publishing state
  published_at          TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ,            -- soft-delete; NULL if live
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT paywalled_has_price CHECK (
    (is_paywalled = FALSE) OR (is_paywalled = TRUE AND price_pence IS NOT NULL)
  )
);

CREATE INDEX idx_articles_writer_id ON articles (writer_id);
CREATE INDEX idx_articles_nostr_d_tag ON articles (writer_id, nostr_d_tag);
CREATE INDEX idx_articles_published_at ON articles (published_at DESC) WHERE published_at IS NOT NULL;
CREATE INDEX idx_articles_title_trgm ON articles USING gin (title gin_trgm_ops);

-- =============================================================================
-- ARTICLE DRAFTS
-- NIP-23 kind 30024. Separate table to keep the articles table clean.
-- =============================================================================

CREATE TABLE article_drafts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  writer_id             UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  nostr_draft_event_id  TEXT UNIQUE,            -- kind 30024 event ID, if relay-synced
  nostr_d_tag           TEXT,                   -- matches article d-tag when editing existing article
  title                 TEXT,
  content_raw           TEXT,                   -- full unsplit draft content
  gate_position_pct     INT,
  price_pence           INT,
  auto_saved_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_drafts_writer_id ON article_drafts (writer_id);

-- =============================================================================
-- VAULT KEYS
-- The key service's private store. Never exposed in Nostr events.
-- =============================================================================

CREATE TABLE vault_keys (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id            UUID NOT NULL REFERENCES articles (id) ON DELETE RESTRICT,
  nostr_article_event_id TEXT NOT NULL UNIQUE,
  content_key_enc       TEXT NOT NULL,          -- AES-256 key, encrypted at rest with platform KMS key
  algorithm             TEXT NOT NULL DEFAULT 'aes-256-gcm',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at            TIMESTAMPTZ             -- NULL = never rotated
);

CREATE INDEX idx_vault_keys_article_id ON vault_keys (article_id);

-- =============================================================================
-- READING TABS
-- One active tab per reader. Tracks the running balance before settlement.
-- =============================================================================

CREATE TABLE reading_tabs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reader_id             UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  balance_pence         INT NOT NULL DEFAULT 0,
  last_read_at          TIMESTAMPTZ,
  last_settled_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT one_tab_per_reader UNIQUE (reader_id)
);

CREATE INDEX idx_reading_tabs_reader_id ON reading_tabs (reader_id);

-- =============================================================================
-- READ EVENTS
-- Every gate-pass produces one row. The operational source of truth for billing.
-- =============================================================================

CREATE TABLE read_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reader_id             UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  article_id            UUID NOT NULL REFERENCES articles (id) ON DELETE RESTRICT,
  writer_id             UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  tab_id                UUID REFERENCES reading_tabs (id) ON DELETE SET NULL,

  amount_pence          INT NOT NULL,
  state                 read_state NOT NULL DEFAULT 'provisional',

  -- Nostr audit trail
  receipt_nostr_event_id TEXT UNIQUE,          -- kind 9901 event ID once published
  reader_pubkey_hash    TEXT,                  -- keyed HMAC of reader pubkey (privacy model)

  -- Settlement linkage
  tab_settlement_id     UUID,                  -- FK added after tab_settlements table created
  writer_payout_id      UUID,                  -- FK added after writer_payouts table created

  -- Free allowance tracking
  on_free_allowance     BOOLEAN NOT NULL DEFAULT FALSE,

  read_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  state_updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_read_events_reader_id ON read_events (reader_id);
CREATE INDEX idx_read_events_article_id ON read_events (article_id);
CREATE INDEX idx_read_events_writer_id ON read_events (writer_id);
CREATE INDEX idx_read_events_state ON read_events (state);
CREATE INDEX idx_read_events_tab_id ON read_events (tab_id);

-- =============================================================================
-- TAB SETTLEMENTS
-- Stage 2: reader's card charged. Money moves from reader to platform.
-- =============================================================================

CREATE TABLE tab_settlements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reader_id             UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  tab_id                UUID NOT NULL REFERENCES reading_tabs (id) ON DELETE RESTRICT,

  amount_pence          INT NOT NULL,           -- gross amount charged to reader
  platform_fee_pence    INT NOT NULL,           -- 8% of amount_pence (inclusive of Stripe fees)
  net_to_writers_pence  INT NOT NULL,           -- amount_pence - platform_fee_pence

  stripe_payment_intent_id TEXT UNIQUE,
  stripe_charge_id         TEXT UNIQUE,
  trigger_type          TEXT NOT NULL CHECK (trigger_type IN ('threshold', 'monthly_fallback')),

  settled_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tab_settlements_reader_id ON tab_settlements (reader_id);
CREATE INDEX idx_tab_settlements_settled_at ON tab_settlements (settled_at DESC);

-- Back-fill FK on read_events
ALTER TABLE read_events
  ADD CONSTRAINT fk_read_events_tab_settlement
  FOREIGN KEY (tab_settlement_id) REFERENCES tab_settlements (id) ON DELETE SET NULL;

-- =============================================================================
-- WRITER PAYOUTS
-- Stage 3: platform pays writer via Stripe Connect.
-- =============================================================================

CREATE TABLE writer_payouts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  writer_id             UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,

  amount_pence          INT NOT NULL,
  stripe_transfer_id    TEXT UNIQUE,
  stripe_connect_id     TEXT NOT NULL,

  status                payout_status NOT NULL DEFAULT 'pending',
  triggered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  failed_reason         TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_writer_payouts_writer_id ON writer_payouts (writer_id);
CREATE INDEX idx_writer_payouts_status ON writer_payouts (status);

-- Back-fill FK on read_events
ALTER TABLE read_events
  ADD CONSTRAINT fk_read_events_writer_payout
  FOREIGN KEY (writer_payout_id) REFERENCES writer_payouts (id) ON DELETE SET NULL;

-- =============================================================================
-- CONTENT KEY ISSUANCES
-- Log of every time the key service issued a content key to a reader.
-- Used for re-issuance (account recovery, new device) and audit.
-- =============================================================================

CREATE TABLE content_key_issuances (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_key_id          UUID NOT NULL REFERENCES vault_keys (id) ON DELETE RESTRICT,
  reader_id             UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  article_id            UUID NOT NULL REFERENCES articles (id) ON DELETE RESTRICT,
  read_event_id         UUID REFERENCES read_events (id) ON DELETE SET NULL,

  issued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_reissuance         BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_key_issuances_reader_article ON content_key_issuances (reader_id, article_id);
CREATE INDEX idx_key_issuances_vault_key_id ON content_key_issuances (vault_key_id);

-- =============================================================================
-- FOLLOWS
-- Stores reader → writer follow relationships.
-- Mirrors the Nostr kind 3 contact list but indexed for feed queries.
-- =============================================================================

CREATE TABLE follows (
  follower_id           UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  followee_id           UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  followed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX idx_follows_followee_id ON follows (followee_id);

-- =============================================================================
-- BLOCKS & MUTES
-- Block is mutual and hard. Mute is personal and soft.
-- =============================================================================

CREATE TABLE blocks (
  blocker_id            UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  blocked_id            UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  blocked_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE mutes (
  muter_id              UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  muted_id              UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  muted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (muter_id, muted_id)
);

-- =============================================================================
-- NOTES
-- Short-form kind 1 content, indexed for feed assembly.
-- Canonical content lives on the relay; this is the app-layer index.
-- =============================================================================

CREATE TABLE notes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id             UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  nostr_event_id        TEXT NOT NULL UNIQUE,
  content               TEXT NOT NULL,
  char_count            INT,
  tier                  content_tier NOT NULL DEFAULT 'tier1',

  -- Quote-comment linkage (kind 1 with q tag)
  is_quote_comment      BOOLEAN NOT NULL DEFAULT FALSE,
  quoted_event_id       TEXT,                   -- nostr_event_id of quoted content
  quoted_event_kind     INT,                    -- kind of quoted content (enables rendering without fetch)

  -- Reply linkage
  reply_to_event_id     TEXT,

  -- Comments
  comments_enabled      BOOLEAN NOT NULL DEFAULT TRUE,

  published_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_author_id ON notes (author_id);
CREATE INDEX idx_notes_published_at ON notes (published_at DESC);
CREATE INDEX idx_notes_reply_to ON notes (reply_to_event_id) WHERE reply_to_event_id IS NOT NULL;

-- =============================================================================
-- FEED ENGAGEMENT
-- Signals used by the For You ranking algorithm.
-- engagement_type: 'reaction' | 'quote_comment' | 'reply' | 'gate_pass'
-- =============================================================================

CREATE TABLE feed_engagement (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id              UUID REFERENCES accounts (id) ON DELETE SET NULL,
  target_nostr_event_id TEXT NOT NULL,
  target_author_id      UUID REFERENCES accounts (id) ON DELETE SET NULL,
  engagement_type       TEXT NOT NULL,
  engaged_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feed_engagement_target ON feed_engagement (target_nostr_event_id, engaged_at DESC);
CREATE INDEX idx_feed_engagement_author ON feed_engagement (target_author_id, engaged_at DESC);

-- =============================================================================
-- MODERATION REPORTS
-- =============================================================================

CREATE TABLE moderation_reports (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id           UUID REFERENCES accounts (id) ON DELETE SET NULL,
  target_nostr_event_id TEXT,                   -- article or note
  target_account_id     UUID REFERENCES accounts (id) ON DELETE SET NULL,
  category              report_category NOT NULL,
  notes                 TEXT,
  status                report_status NOT NULL DEFAULT 'open',
  reviewed_by           UUID REFERENCES accounts (id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reports_status ON moderation_reports (status, created_at DESC);

-- =============================================================================
-- PLATFORM CONFIGURATION
-- Key-value store for threshold values and tunable parameters.
-- Values defined in ADR §II.3 as provisional and subject to post-launch review.
-- =============================================================================

CREATE TABLE platform_config (
  key                   TEXT PRIMARY KEY,
  value                 TEXT NOT NULL,
  description           TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_config (key, value, description) VALUES
  ('free_allowance_pence',          '500',  'New reader free allowance (£5.00)'),
  ('tab_settlement_threshold_pence','800',  'Reader tab threshold that triggers Stripe charge (£8.00)'),
  ('monthly_fallback_minimum_pence','200',  'Minimum balance for time-based settlement trigger (£2.00)'),
  ('writer_payout_threshold_pence', '2000', 'Writer balance threshold that triggers Stripe Connect transfer (£20.00)'),
  ('platform_fee_bps',              '800',  'Platform cut in basis points (800 = 8%)'),
  ('for_you_engagement_weight',     '0.6',  'Weight of engagement velocity vs revenue conversion in For You ranking'),
  ('for_you_revenue_weight',        '0.4',  'Weight of revenue conversion in For You ranking'),
  ('note_char_limit',               '1000', 'Maximum characters for a note (kind 1)'),
  ('comment_char_limit',            '2000', 'Maximum characters for a comment'),
  ('media_max_size_bytes',          '10485760', 'Maximum upload file size (10 MB)');

-- =============================================================================
-- COMMENTS
-- Indexed app-layer store for Nostr kind 1 reply events.
-- Canonical content lives on the relay; this table is for feed/thread queries.
-- =============================================================================

CREATE TABLE comments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  nostr_event_id        TEXT NOT NULL UNIQUE,
  target_event_id       TEXT NOT NULL,          -- nostr_event_id of the article or note
  target_kind           INT NOT NULL,           -- kind of target (1 = note, 30023 = article)
  parent_comment_id     UUID REFERENCES comments(id) ON DELETE CASCADE,
  content               TEXT NOT NULL,
  published_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,            -- soft-delete; NULL if live
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comments_target ON comments(target_event_id, published_at ASC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_comments_author ON comments(author_id);
CREATE INDEX idx_comments_parent ON comments(parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

-- =============================================================================
-- MEDIA UPLOADS
-- Tracks Blossom uploads for moderation, quotas, and deduplication.
-- =============================================================================

CREATE TABLE media_uploads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  blossom_url           TEXT NOT NULL,
  sha256                TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  size_bytes            INT NOT NULL,
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_uploads_uploader ON media_uploads(uploader_id);
CREATE INDEX idx_media_uploads_sha256 ON media_uploads(sha256);

-- =============================================================================
-- UPDATED_AT TRIGGERS
-- Auto-update updated_at on mutation for key tables.
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_articles_updated_at
  BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_reading_tabs_updated_at
  BEFORE UPDATE ON reading_tabs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
