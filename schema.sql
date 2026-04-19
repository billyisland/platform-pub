-- =============================================================================
-- all.haus — PostgreSQL Schema
-- Full schema incorporating migrations 001–038.
-- Loaded by Docker initdb.d on first boot.
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
  'moderated',         -- content removed from surface; identity intact
  'deactivated'        -- self-service deactivation; reversible by logging in
);

CREATE TYPE payout_status AS ENUM (
  'pending',           -- below £20 threshold or Stripe KYC incomplete
  'initiated',         -- Stripe Connect transfer initiated
  'completed',         -- funds reached writer's bank
  'failed'
);

CREATE TYPE publication_role AS ENUM (
  'editor_in_chief',
  'editor',
  'contributor'
);

CREATE TYPE contributor_type AS ENUM (
  'permanent',
  'one_off'
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

-- Pledge drive enums (migration 017)
CREATE TYPE drive_status AS ENUM (
  'open',        -- accepting pledges
  'funded',      -- target reached (still accepting pledges)
  'published',   -- article published, fulfilment pending
  'fulfilled',   -- all pledges processed, access granted
  'expired',     -- deadline passed without publication
  'cancelled'    -- creator deleted the drive
);

CREATE TYPE drive_origin AS ENUM (
  'crowdfund',   -- creator is the writer
  'commission'   -- creator is a reader, target writer is specified
);

CREATE TYPE pledge_status AS ENUM (
  'active',      -- pledge is live, awaiting publication
  'fulfilled',   -- article published, read_event created, access granted
  'void'         -- drive cancelled or expired, pledge is void
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
  email                 TEXT UNIQUE,            -- (migration 001)
  is_writer             BOOLEAN NOT NULL DEFAULT FALSE,
  is_reader             BOOLEAN NOT NULL DEFAULT TRUE,
  status                account_status NOT NULL DEFAULT 'active',
  stripe_customer_id    TEXT UNIQUE,            -- Stripe customer ID for readers
  stripe_connect_id     TEXT UNIQUE,            -- Stripe Connect account ID for writers
  stripe_connect_kyc_complete BOOLEAN NOT NULL DEFAULT FALSE,
  hosting_type          TEXT NOT NULL DEFAULT 'hosted' CHECK (hosting_type IN ('hosted', 'self_hosted')),
  self_hosted_relay_url TEXT,                   -- populated for self-hosted writers
  free_allowance_remaining_pence INT NOT NULL DEFAULT 500,  -- £5.00 in pence
  subscription_price_pence INTEGER NOT NULL DEFAULT 500,    -- writer-configurable (migration 005)
  annual_discount_pct INTEGER NOT NULL DEFAULT 15 CHECK (annual_discount_pct BETWEEN 0 AND 30), -- (migration 024)
  default_article_price_pence INT,  -- NULL = auto-suggest by word count (migration 039)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  show_commission_button BOOLEAN NOT NULL DEFAULT TRUE,  -- (migration 030) let authors hide commission button
  sessions_invalidated_at TIMESTAMPTZ,                  -- (migration 043) NULL = no invalidation; set on logout to reject older JWTs
  username_changed_at   TIMESTAMPTZ,                    -- (migration 049) 30-day cooldown tracking
  previous_username     TEXT,                           -- (migration 049) for 90-day redirect
  username_redirect_until TIMESTAMPTZ,                  -- (migration 049) redirect expiry
  pending_email         TEXT,                           -- (migration 049) email change in progress
  email_verification_token TEXT,                        -- (migration 049) token for email change verification
  always_open_articles_at_top BOOLEAN NOT NULL DEFAULT FALSE, -- (migration 069) bypass scroll-resume
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_accounts_nostr_pubkey ON accounts (nostr_pubkey);
CREATE INDEX idx_accounts_username ON accounts (username);
CREATE INDEX idx_accounts_is_writer ON accounts (is_writer) WHERE is_writer = TRUE;
CREATE INDEX idx_accounts_email ON accounts (email) WHERE email IS NOT NULL;

-- =============================================================================
-- MAGIC LINKS (migration 001)
-- Token-based passwordless login. Each token is single-use, expires in 15 min.
-- =============================================================================

CREATE TABLE magic_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,   -- SHA-256 hash of the token (never store raw)
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,            -- NULL = unused
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_magic_links_token_hash ON magic_links (token_hash) WHERE used_at IS NULL;
CREATE INDEX idx_magic_links_expires ON magic_links (expires_at) WHERE used_at IS NULL;

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
  size_tier             TEXT CHECK (size_tier IS NULL OR size_tier IN ('lead', 'standard', 'brief')), -- migration 068

  -- Access control
  access_mode           TEXT NOT NULL DEFAULT 'public',  -- 'public' | 'paywalled' | 'invitation_only'
  price_pence           INT,                    -- NULL = free; price in pence
  gate_position_pct     INT CHECK (gate_position_pct BETWEEN 1 AND 99), -- default 50
  vault_event_id        TEXT UNIQUE,            -- Nostr event ID of kind 39701 vault

  -- Comments
  comments_enabled      BOOLEAN NOT NULL DEFAULT TRUE,

  -- Profile pinning (migration 026)
  pinned_on_profile     BOOLEAN NOT NULL DEFAULT FALSE,
  profile_pin_order     INTEGER NOT NULL DEFAULT 0,

  -- Publication (migration 038)
  publication_id        UUID,                   -- NULL for personal articles
  publication_article_status TEXT
    CHECK (publication_article_status IN ('submitted', 'approved', 'published', 'unpublished')),
  show_on_writer_profile BOOLEAN NOT NULL DEFAULT TRUE,

  -- Email
  email_sent_at         TIMESTAMPTZ,            -- when publish email was sent (NULL if never)

  -- Publishing state
  published_at          TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ,            -- soft-delete; NULL if live
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT access_mode_price CHECK (
    (access_mode = 'public') OR
    (access_mode = 'paywalled' AND price_pence IS NOT NULL) OR
    (access_mode = 'invitation_only')
  )
);

CREATE INDEX idx_articles_writer_id ON articles (writer_id);
CREATE INDEX idx_articles_nostr_d_tag ON articles (writer_id, nostr_d_tag);
CREATE INDEX idx_articles_published_at ON articles (published_at DESC) WHERE published_at IS NOT NULL;
CREATE INDEX idx_articles_title_trgm ON articles USING gin (title gin_trgm_ops);
CREATE INDEX idx_articles_publication ON articles (publication_id) WHERE publication_id IS NOT NULL;

-- One live article per (writer, d-tag). Deleted rows are excluded. (migration 008)
CREATE UNIQUE INDEX idx_articles_unique_live
  ON articles (writer_id, nostr_d_tag)
  WHERE deleted_at IS NULL;

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
  publication_id        UUID,                   -- (migration 038) publication context
  auto_saved_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_drafts_writer_id ON article_drafts (writer_id);

-- Partial unique index for upsert by (writer_id, nostr_d_tag) when d-tag is non-null. (migration 002)
CREATE UNIQUE INDEX idx_drafts_writer_dtag
  ON article_drafts (writer_id, nostr_d_tag)
  WHERE nostr_d_tag IS NOT NULL;

-- =============================================================================
-- GIFT LINKS (migration 029)
-- Shareable URLs that grant free access to paywalled articles, with a
-- configurable redemption limit.
-- =============================================================================

CREATE TABLE gift_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id        UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  creator_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token             TEXT NOT NULL UNIQUE,
  max_redemptions   INT NOT NULL DEFAULT 5,
  redemption_count  INT NOT NULL DEFAULT 0,
  revoked_at        TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_gift_links_token ON gift_links(token);
CREATE INDEX idx_gift_links_article ON gift_links(article_id);

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
  ciphertext            TEXT,                   -- encrypted paywall body, stored for resilience (migration 011)
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
-- SUBSCRIPTION OFFERS (migration 037)
-- Flexible discount codes and gifted subscriptions for writers.
-- Two modes: 'code' (shareable link) and 'grant' (assigned to specific reader).
-- =============================================================================

CREATE TABLE subscription_offers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  writer_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('code', 'grant')),
  discount_pct      INTEGER NOT NULL CHECK (discount_pct BETWEEN 0 AND 100),
  duration_months   INTEGER,                          -- NULL = permanent discount
  code              TEXT UNIQUE,                       -- for mode='code' only
  recipient_id      UUID REFERENCES accounts(id),      -- for mode='grant' only
  max_redemptions   INTEGER,                           -- NULL = unlimited (code mode)
  redemption_count  INTEGER NOT NULL DEFAULT 0,
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sub_offers_writer ON subscription_offers(writer_id);
CREATE INDEX idx_sub_offers_code ON subscription_offers(code) WHERE code IS NOT NULL;
CREATE INDEX idx_sub_offers_recipient ON subscription_offers(recipient_id) WHERE recipient_id IS NOT NULL;

-- =============================================================================
-- SUBSCRIPTIONS (migration 005)
-- Reader ↔ writer monthly relationships.
-- Status lifecycle: active → cancelled → expired
-- =============================================================================

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reader_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  writer_id UUID REFERENCES accounts(id) ON DELETE CASCADE, -- NULL for publication subscriptions (migration 038)
  publication_id UUID,                              -- (migration 038) NULL for writer subscriptions
  price_pence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
  auto_renew BOOLEAN NOT NULL DEFAULT TRUE,      -- (migration 023) FALSE = expires at period end
  subscription_period TEXT NOT NULL DEFAULT 'monthly' CHECK (subscription_period IN ('monthly', 'annual')), -- (migration 024)
  is_comp BOOLEAN NOT NULL DEFAULT FALSE,        -- (migration 025) complimentary sub granted by writer
  hidden BOOLEAN NOT NULL DEFAULT FALSE,          -- (migration 027) hide from public profile
  notify_on_publish BOOLEAN NOT NULL DEFAULT TRUE, -- (migration 042) email when writer publishes
  nostr_event_id TEXT,                           -- kind 7003 subscription attestation (migration 007)
  offer_id UUID REFERENCES subscription_offers(id), -- (migration 037) offer used at subscribe time
  offer_periods_remaining INTEGER,               -- (migration 037) NULL = permanent or no offer
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '1 month'),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_target_check CHECK (num_nonnulls(writer_id, publication_id) = 1)
);

CREATE INDEX idx_subscriptions_reader ON subscriptions(reader_id);
CREATE INDEX idx_subscriptions_writer ON subscriptions(writer_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status) WHERE status = 'active' OR status = 'cancelled';
CREATE INDEX idx_subscriptions_period_end ON subscriptions(current_period_end) WHERE status IN ('active', 'cancelled');
CREATE UNIQUE INDEX idx_subscriptions_reader_writer ON subscriptions (reader_id, writer_id) WHERE writer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_subscriptions_reader_publication ON subscriptions (reader_id, publication_id) WHERE publication_id IS NOT NULL;

-- =============================================================================
-- SUBSCRIPTION NUDGE LOG (migration 028)
-- Tracks when the spend-threshold subscription nudge has been shown to a
-- reader for a given writer in a given calendar month.
-- =============================================================================

CREATE TABLE subscription_nudge_log (
  reader_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  writer_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  publication_id UUID,                              -- (migration 038) publication nudges
  month     DATE NOT NULL,
  shown_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (reader_id, writer_id, month)
);

-- =============================================================================
-- SUBSCRIPTION EVENTS (migration 005)
-- Audit log for credits/debits dashboards.
-- =============================================================================

CREATE TABLE subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('subscription_charge', 'subscription_earning', 'subscription_read', 'expiry_warning_sent')),
  reader_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  writer_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id),
  amount_pence INTEGER NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sub_events_subscription ON subscription_events(subscription_id);
CREATE INDEX idx_sub_events_reader ON subscription_events(reader_id);
CREATE INDEX idx_sub_events_writer ON subscription_events(writer_id);
CREATE INDEX idx_sub_events_type ON subscription_events(event_type);
CREATE INDEX idx_sub_events_created ON subscription_events(created_at DESC);

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
  reader_pubkey         TEXT,                  -- actual Nostr pubkey (stored privately; not on public relay)
  receipt_token         TEXT,                  -- portable signed Nostr event JSON for reader export

  -- Settlement linkage
  tab_settlement_id     UUID,                  -- FK added after tab_settlements table created
  writer_payout_id      UUID,                  -- FK added after writer_payouts table created

  -- Free allowance tracking
  on_free_allowance     BOOLEAN NOT NULL DEFAULT FALSE,

  -- Subscription linkage (migration 005)
  via_subscription_id   UUID REFERENCES subscriptions(id),
  is_subscription_read  BOOLEAN NOT NULL DEFAULT FALSE,

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
-- ARTICLE UNLOCKS (migration 005)
-- Permanent unlock records — survives subscription cancellation.
-- =============================================================================

CREATE TABLE article_unlocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reader_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  unlocked_via TEXT NOT NULL CHECK (unlocked_via IN (
    'purchase', 'subscription', 'own_content', 'free_allowance',
    'author_grant', 'pledge', 'invitation'
  )),
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reader_id, article_id)
);

CREATE INDEX idx_article_unlocks_reader ON article_unlocks(reader_id);
CREATE INDEX idx_article_unlocks_article ON article_unlocks(article_id);

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
  quoted_excerpt        TEXT,                   -- (migration 013)
  quoted_title          TEXT,                   -- (migration 013)
  quoted_author         TEXT,                   -- (migration 013)

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
-- FEED SCORES
-- Pre-computed engagement scores for ranked feed modes (explore, following_plus,
-- extended). Refreshed by background worker every 5 minutes using HN-style
-- gravity formula.
-- =============================================================================

CREATE TABLE feed_scores (
  nostr_event_id  TEXT PRIMARY KEY,
  author_id       UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  content_type    content_type NOT NULL,
  publication_id  UUID,                             -- (migration 038) publication article scoring
  score           FLOAT NOT NULL DEFAULT 0,
  engagement_count INT NOT NULL DEFAULT 0,
  gate_pass_count INT NOT NULL DEFAULT 0,
  published_at    TIMESTAMPTZ NOT NULL,
  scored_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feed_scores_score ON feed_scores (score DESC);
CREATE INDEX idx_feed_scores_author ON feed_scores (author_id, score DESC);
CREATE INDEX idx_feed_scores_published ON feed_scores (published_at DESC);
CREATE INDEX idx_feed_scores_publication ON feed_scores (publication_id, score DESC)
  WHERE publication_id IS NOT NULL;

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
  ('feed_gravity',                   '1.5',  'Time-decay exponent for feed scoring (HN-style)'),
  ('feed_weight_reaction',           '1',   'Score weight for reactions'),
  ('feed_weight_reply',              '2',   'Score weight for replies'),
  ('feed_weight_quote_comment',      '3',   'Score weight for quote comments'),
  ('feed_weight_gate_pass',          '5',   'Score weight for gate passes (paid reads)'),
  ('note_char_limit',               '1000', 'Maximum characters for a note (kind 1)'),
  ('comment_char_limit',            '2000', 'Maximum characters for a comment'),
  ('media_max_size_bytes',          '10485760', 'Maximum upload file size (10 MB)'),
  ('admin_account_ids',             '',         'Comma-separated account UUIDs with admin access'),
  ('monthly_fallback_days',         '30',       'Days since last read before monthly settlement fires'),
  ('publication_payout_threshold_pence', '2000', 'Publication payout threshold (£20.00)');

-- =============================================================================
-- COMMENTS
-- Indexed app-layer store for Nostr kind 1 reply events.
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
-- NOTIFICATIONS (migration 009)
-- =============================================================================

CREATE TABLE notifications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  actor_id      UUID        REFERENCES accounts(id) ON DELETE SET NULL,
  type          TEXT        NOT NULL,
  article_id    UUID        REFERENCES articles(id) ON DELETE CASCADE,
  comment_id    UUID        REFERENCES comments(id) ON DELETE CASCADE,
  note_id          UUID        REFERENCES notes(id) ON DELETE CASCADE,  -- (migration 012)
  conversation_id  UUID        REFERENCES conversations(id) ON DELETE SET NULL,  -- (migration 020)
  drive_id         UUID        REFERENCES pledge_drives(id) ON DELETE SET NULL,  -- (migration 020)
  read             BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, created_at DESC);
CREATE INDEX idx_notifications_note ON notifications(note_id) WHERE note_id IS NOT NULL;

-- Prevent duplicate *unread* notifications (migration 014 → fixed in 019)
-- Partial index: only unread rows are constrained, so once a notification is
-- read a new event of the same kind can insert a fresh row.
CREATE UNIQUE INDEX idx_notifications_dedup
  ON notifications (
    recipient_id,
    COALESCE(actor_id, '00000000-0000-0000-0000-000000000000'),
    type,
    COALESCE(article_id, '00000000-0000-0000-0000-000000000000'),
    COALESCE(note_id, '00000000-0000-0000-0000-000000000000'),
    COALESCE(comment_id, '00000000-0000-0000-0000-000000000000')
  )
  WHERE read = false;

-- Notification preferences (migration 046)
CREATE TABLE notification_preferences (
  user_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

-- Bookmarks (migration 047)
CREATE TABLE bookmarks (
  user_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id    UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

CREATE INDEX idx_bookmarks_user ON bookmarks(user_id, created_at DESC);

-- Reading positions (migration 069) — per-user, per-article scroll snapshot
CREATE TABLE reading_positions (
  user_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id    UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  scroll_ratio  REAL NOT NULL CHECK (scroll_ratio >= 0 AND scroll_ratio <= 1),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

CREATE INDEX idx_reading_positions_user ON reading_positions(user_id, updated_at DESC);

-- Tags (migration 048)
CREATE TABLE tags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE article_tags (
  article_id  UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE INDEX idx_article_tags_tag ON article_tags(tag_id);
CREATE INDEX idx_tags_name ON tags(name);

-- =============================================================================
-- VOTES (migration 010)
-- Individual vote events for upvoting/downvoting content.
-- =============================================================================

CREATE TABLE votes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voter_id              UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_nostr_event_id TEXT NOT NULL,
  target_author_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  direction             TEXT NOT NULL CHECK (direction IN ('up', 'down')),

  -- Pricing at time of vote (immutable audit trail)
  sequence_number       INT NOT NULL,
  cost_pence            BIGINT NOT NULL DEFAULT 0,

  -- Billing linkage
  tab_id                UUID REFERENCES reading_tabs(id) ON DELETE SET NULL,
  on_free_allowance     BOOLEAN NOT NULL DEFAULT FALSE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_votes_target ON votes(target_nostr_event_id);
CREATE INDEX idx_votes_voter_target ON votes(voter_id, target_nostr_event_id, direction);
CREATE INDEX idx_votes_author ON votes(target_author_id);
CREATE INDEX idx_votes_created ON votes(created_at DESC);

-- Materialised vote tallies for fast display.
CREATE TABLE vote_tallies (
  target_nostr_event_id TEXT PRIMARY KEY,
  upvote_count          INT NOT NULL DEFAULT 0,
  downvote_count        INT NOT NULL DEFAULT 0,
  net_score             INT NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vote charges — billing records for paid votes.
CREATE TABLE vote_charges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id           UUID NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  voter_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  recipient_id      UUID REFERENCES accounts(id) ON DELETE RESTRICT, -- NULL for downvotes (platform revenue)
  amount_pence      BIGINT NOT NULL,
  tab_id            UUID REFERENCES reading_tabs(id) ON DELETE SET NULL,
  on_free_allowance BOOLEAN NOT NULL DEFAULT FALSE,
  state             read_state NOT NULL DEFAULT 'provisional',
  writer_payout_id  UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vote_charges
  ADD CONSTRAINT fk_vote_charges_writer_payout
  FOREIGN KEY (writer_payout_id) REFERENCES writer_payouts (id) ON DELETE SET NULL;

CREATE INDEX idx_vote_charges_vote_id ON vote_charges(vote_id);
CREATE INDEX idx_vote_charges_voter_id ON vote_charges(voter_id);
CREATE INDEX idx_vote_charges_recipient_id ON vote_charges(recipient_id) WHERE recipient_id IS NOT NULL;
CREATE INDEX idx_vote_charges_state ON vote_charges(state);
CREATE INDEX idx_vote_charges_tab_id ON vote_charges(tab_id) WHERE tab_id IS NOT NULL;

-- =============================================================================
-- DIRECT MESSAGES (migration 016)
-- =============================================================================

CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX idx_conv_members_user ON conversation_members(user_id);

CREATE TABLE direct_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  content_enc      TEXT NOT NULL,  -- NIP-44 encrypted to recipient's pubkey
  nostr_event_id   TEXT UNIQUE,
  reply_to_id      UUID REFERENCES direct_messages(id) ON DELETE SET NULL,
  -- send_id groups the N per-recipient rows produced by a single logical
  -- send. Read path uses DISTINCT ON (send_id) so the sender of a group DM
  -- doesn't see their own message once per recipient.
  send_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dm_conversation ON direct_messages(conversation_id, created_at DESC);
CREATE INDEX idx_dm_sender ON direct_messages(sender_id);
CREATE INDEX idx_dm_recipient ON direct_messages(recipient_id);
CREATE INDEX idx_dm_reply_to ON direct_messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX idx_dm_send_id ON direct_messages (send_id);

CREATE TABLE dm_pricing (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_id     UUID REFERENCES accounts(id) ON DELETE CASCADE,  -- NULL = default rate for all senders
  price_pence   INT NOT NULL,
  UNIQUE (owner_id, target_id)
);

CREATE UNIQUE INDEX idx_dm_pricing_default ON dm_pricing(owner_id) WHERE target_id IS NULL;

CREATE TABLE dm_likes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID        NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

CREATE INDEX idx_dm_likes_message ON dm_likes (message_id);

-- =============================================================================
-- PLEDGE DRIVES (migration 017)
-- =============================================================================

CREATE TABLE pledge_drives (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  origin                drive_origin NOT NULL,
  target_writer_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  description           TEXT,
  funding_target_pence  INT,
  current_total_pence   INT NOT NULL DEFAULT 0,
  suggested_price_pence INT,
  status                drive_status NOT NULL DEFAULT 'open',
  article_id            UUID REFERENCES articles(id),
  draft_id              UUID REFERENCES article_drafts(id),
  nostr_event_id        TEXT UNIQUE,
  pinned                BOOLEAN NOT NULL DEFAULT TRUE,
  accepted_at           TIMESTAMPTZ,
  deadline              TIMESTAMPTZ,
  published_at          TIMESTAMPTZ,
  fulfilled_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  parent_note_event_id  TEXT,                          -- (migration 030) thread commissions to source note
  acceptance_terms      TEXT,                          -- (migration 030) terms recorded on acceptance
  backer_access_mode    TEXT CHECK (backer_access_mode IN ('free', 'paywalled')) DEFAULT 'free', -- (migration 030)
  parent_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL, -- (migration 036) commission from DM
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_drives_creator ON pledge_drives(creator_id);
CREATE INDEX idx_drives_writer ON pledge_drives(target_writer_id);
CREATE INDEX idx_drives_status ON pledge_drives(status);
CREATE INDEX idx_drives_nostr ON pledge_drives(nostr_event_id);
CREATE INDEX idx_drives_parent_note ON pledge_drives(parent_note_event_id)
  WHERE parent_note_event_id IS NOT NULL;
CREATE INDEX idx_drives_parent_conv ON pledge_drives(parent_conversation_id)
  WHERE parent_conversation_id IS NOT NULL;

CREATE TABLE pledges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_id      UUID NOT NULL REFERENCES pledge_drives(id),
  pledger_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount_pence  INT NOT NULL,
  status        pledge_status NOT NULL DEFAULT 'active',
  read_event_id UUID REFERENCES read_events(id),
  fulfilled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drive_id, pledger_id)
);

CREATE INDEX idx_pledges_drive ON pledges(drive_id);
CREATE INDEX idx_pledges_pledger ON pledges(pledger_id);
CREATE INDEX idx_pledges_status ON pledges(status);

-- =============================================================================
-- PUBLICATIONS (migration 038)
-- Federated groups of writers with shared identity, paywall, and revenue pool.
-- =============================================================================

CREATE TABLE publications (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  tagline                     TEXT,
  about                       TEXT,
  logo_blossom_url            TEXT,
  cover_blossom_url           TEXT,
  nostr_pubkey                TEXT NOT NULL UNIQUE,
  nostr_privkey_enc           TEXT NOT NULL,
  subscription_price_pence    INTEGER NOT NULL DEFAULT 800,
  annual_discount_pct         INTEGER NOT NULL DEFAULT 15,
  default_article_price_pence INTEGER NOT NULL DEFAULT 20,
  article_price_mode          TEXT NOT NULL DEFAULT 'per_article'
                              CHECK (article_price_mode IN ('per_article', 'per_1000_words')),
  homepage_layout             TEXT NOT NULL DEFAULT 'blog' CHECK (homepage_layout IN ('blog', 'magazine', 'minimal')),
  custom_domain               TEXT UNIQUE,
  custom_domain_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  theme_config                JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_css                  TEXT,
  stripe_connect_id           TEXT UNIQUE,
  stripe_connect_kyc_complete BOOLEAN NOT NULL DEFAULT FALSE,
  status                      TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'suspended', 'archived')),
  founded_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_publications_slug ON publications (slug);
CREATE INDEX idx_publications_custom_domain ON publications (custom_domain)
  WHERE custom_domain IS NOT NULL;
CREATE INDEX idx_publications_nostr_pubkey ON publications (nostr_pubkey);
CREATE INDEX idx_publications_name_trgm ON publications USING gin (name gin_trgm_ops);

-- Add FK now that publications table exists
ALTER TABLE articles ADD CONSTRAINT fk_articles_publication
  FOREIGN KEY (publication_id) REFERENCES publications(id);
ALTER TABLE article_drafts ADD CONSTRAINT fk_article_drafts_publication
  FOREIGN KEY (publication_id) REFERENCES publications(id);
ALTER TABLE subscriptions ADD CONSTRAINT fk_subscriptions_publication
  FOREIGN KEY (publication_id) REFERENCES publications(id);

CREATE TABLE publication_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id        UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role                  publication_role NOT NULL,
  contributor_type      contributor_type NOT NULL DEFAULT 'permanent',
  title                 TEXT,
  is_owner              BOOLEAN NOT NULL DEFAULT FALSE,
  revenue_share_bps     INTEGER,
  can_publish           BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit_others       BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_members    BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_finances   BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_settings   BOOLEAN NOT NULL DEFAULT FALSE,
  invited_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at           TIMESTAMPTZ,
  removed_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_active_member UNIQUE (publication_id, account_id)
);

CREATE INDEX idx_pub_members_publication ON publication_members (publication_id)
  WHERE removed_at IS NULL;
CREATE INDEX idx_pub_members_account ON publication_members (account_id)
  WHERE removed_at IS NULL;
CREATE UNIQUE INDEX idx_pub_members_one_owner
  ON publication_members (publication_id)
  WHERE is_owner = TRUE AND removed_at IS NULL;

CREATE TABLE publication_invites (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id    UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  invited_by        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invited_email     TEXT,
  invited_account_id UUID REFERENCES accounts(id),
  role              publication_role NOT NULL DEFAULT 'contributor',
  contributor_type  contributor_type NOT NULL DEFAULT 'permanent',
  token             TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  message           TEXT,
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '14 days'),
  accepted_at       TIMESTAMPTZ,
  declined_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pub_invites_token ON publication_invites (token)
  WHERE accepted_at IS NULL AND declined_at IS NULL;
CREATE INDEX idx_pub_invites_email ON publication_invites (invited_email)
  WHERE accepted_at IS NULL AND declined_at IS NULL;

CREATE TABLE publication_article_shares (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id    UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  article_id        UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  share_type        TEXT NOT NULL CHECK (share_type IN ('revenue_bps', 'flat_fee_pence')),
  share_value       INTEGER NOT NULL,
  paid_out          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (article_id, account_id)
);

CREATE TABLE publication_follows (
  follower_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  publication_id  UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  followed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, publication_id)
);

CREATE INDEX idx_pub_follows_publication ON publication_follows (publication_id);

CREATE TABLE publication_payouts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id      UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  total_pool_pence    INTEGER NOT NULL,
  platform_fee_pence  INTEGER NOT NULL,
  flat_fees_paid_pence INTEGER NOT NULL DEFAULT 0,
  remaining_pool_pence INTEGER NOT NULL,
  status              payout_status NOT NULL DEFAULT 'pending',
  triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pub_payouts_publication ON publication_payouts (publication_id);
CREATE INDEX idx_pub_payouts_status ON publication_payouts (status);

CREATE TABLE publication_payout_splits (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_payout_id UUID NOT NULL REFERENCES publication_payouts(id) ON DELETE CASCADE,
  account_id            UUID NOT NULL REFERENCES accounts(id),
  share_bps             INTEGER,
  amount_pence          INTEGER NOT NULL,
  share_type            TEXT NOT NULL CHECK (share_type IN ('standing', 'article_revenue', 'flat_fee')),
  article_id            UUID REFERENCES articles(id),
  stripe_transfer_id    TEXT,
  status                payout_status NOT NULL DEFAULT 'pending',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pub_payout_splits_payout ON publication_payout_splits (publication_payout_id);
CREATE INDEX idx_pub_payout_splits_account ON publication_payout_splits (account_id);

-- =============================================================================
-- STRIPE WEBHOOK DEDUPLICATION
-- Prevents reprocessing of duplicate webhook events (Stripe at-least-once delivery).
-- =============================================================================

CREATE TABLE stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL until the handler has run to completion. Dedup checks
  -- processed_at IS NOT NULL so a crashed handler is re-attempted on
  -- Stripe's next retry rather than silently acked.
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_stripe_webhook_events_processed
  ON stripe_webhook_events(processed_at);

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

CREATE TRIGGER trg_pledge_drives_updated_at
  BEFORE UPDATE ON pledge_drives
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_publications_updated_at
  BEFORE UPDATE ON publications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_publication_members_updated_at
  BEFORE UPDATE ON publication_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Derive articles.size_tier from word_count on INSERT when not explicitly set
-- (editorial overrides survive re-publish). See migration 068.
CREATE FUNCTION articles_derive_size_tier() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.size_tier IS NULL THEN
    NEW.size_tier := CASE
      WHEN NEW.word_count IS NULL OR NEW.word_count < 1000 THEN 'brief'
      WHEN NEW.word_count >= 3000                          THEN 'lead'
      ELSE 'standard'
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER articles_size_tier_default
  BEFORE INSERT ON articles
  FOR EACH ROW EXECUTE FUNCTION articles_derive_size_tier();

-- =============================================================================
-- Universal Feed — external sources, subscriptions, items (migration 052)
-- =============================================================================

CREATE TYPE external_protocol AS ENUM (
  'atproto',
  'activitypub',
  'rss',
  'nostr_external'
);

CREATE TABLE external_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol        external_protocol NOT NULL,
  source_uri      TEXT NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  description     TEXT,
  relay_urls      TEXT[],
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
CREATE INDEX idx_ext_sources_next_fetch ON external_sources(last_fetched_at) WHERE is_active = TRUE;

CREATE TABLE external_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  is_muted      BOOLEAN NOT NULL DEFAULT FALSE,
  daily_cap     INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_subscription UNIQUE (subscriber_id, source_id)
);

CREATE INDEX idx_ext_subs_subscriber ON external_subscriptions(subscriber_id);
CREATE INDEX idx_ext_subs_source     ON external_subscriptions(source_id);

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
  source_item_uri   TEXT NOT NULL,
  author_name       TEXT,
  author_handle     TEXT,
  author_avatar_url TEXT,
  author_uri        TEXT,
  content_text      TEXT,
  content_html      TEXT,
  summary           TEXT,
  title             TEXT,
  language          TEXT,
  media             JSONB DEFAULT '[]',
  source_reply_uri  TEXT,
  source_quote_uri  TEXT,
  is_repost         BOOLEAN NOT NULL DEFAULT FALSE,
  original_item_uri TEXT,
  interaction_data  JSONB DEFAULT '{}',
  published_at      TIMESTAMPTZ NOT NULL,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT unique_source_item UNIQUE (protocol, source_item_uri)
);

CREATE INDEX idx_ext_items_source_id    ON external_items(source_id);
CREATE INDEX idx_ext_items_published_at ON external_items(published_at DESC);
CREATE INDEX idx_ext_items_author_uri   ON external_items(author_uri);
CREATE INDEX idx_ext_items_source_reply ON external_items(source_reply_uri) WHERE source_reply_uri IS NOT NULL;

-- =============================================================================
-- Unified timeline — feed_items (migration 053)
-- =============================================================================

CREATE TABLE feed_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type         TEXT NOT NULL CHECK (item_type IN ('article', 'note', 'external')),
  article_id        UUID REFERENCES articles(id) ON DELETE CASCADE,
  note_id           UUID REFERENCES notes(id) ON DELETE CASCADE,
  external_item_id  UUID REFERENCES external_items(id) ON DELETE CASCADE,
  author_id         UUID REFERENCES accounts(id) ON DELETE SET NULL,
  author_name       TEXT NOT NULL,
  author_avatar     TEXT,
  author_username   TEXT,
  title             TEXT,
  content_preview   TEXT,
  nostr_event_id    TEXT,
  tier              content_tier NOT NULL DEFAULT 'tier1',
  published_at      TIMESTAMPTZ NOT NULL,
  source_protocol   TEXT,
  source_item_uri   TEXT,
  source_id         UUID REFERENCES external_sources(id) ON DELETE CASCADE,
  media             JSONB,
  score             FLOAT NOT NULL DEFAULT 0,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exactly_one_source CHECK (
    (article_id IS NOT NULL)::int +
    (note_id IS NOT NULL)::int +
    (external_item_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT tier_consistency CHECK (
    (item_type IN ('article', 'note') AND tier = 'tier1') OR
    (item_type = 'external')
  )
);

CREATE INDEX idx_feed_items_cursor  ON feed_items(published_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_feed_items_author  ON feed_items(author_id, published_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_feed_items_source  ON feed_items(source_id, published_at DESC) WHERE source_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_feed_items_score   ON feed_items(score DESC, published_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_feed_items_article  ON feed_items(article_id) WHERE article_id IS NOT NULL;
CREATE UNIQUE INDEX idx_feed_items_note     ON feed_items(note_id) WHERE note_id IS NOT NULL;
CREATE UNIQUE INDEX idx_feed_items_external ON feed_items(external_item_id) WHERE external_item_id IS NOT NULL;
CREATE INDEX idx_feed_items_type    ON feed_items(item_type, published_at DESC) WHERE deleted_at IS NULL;

-- =============================================================================
-- ActivityPub instance health (migration 056)
-- Per-host outbox-poll success/failure tallies, surfaced via the admin route
-- GET /admin/activitypub/instance-health.
-- =============================================================================

CREATE TABLE activitypub_instance_health (
  host            TEXT PRIMARY KEY,
  success_count   BIGINT NOT NULL DEFAULT 0,
  failure_count   BIGINT NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ap_instance_health_updated ON activitypub_instance_health(updated_at DESC);

-- =============================================================================
-- Migration tracking
--
-- Pre-seed the _migrations table so the migration runner knows that a fresh
-- database initialised from this schema already includes everything through
-- migration 054. Without this, the runner would attempt to re-apply all
-- migrations on a fresh deploy.
-- =============================================================================

CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO _migrations (filename) VALUES
  ('001_add_email_and_magic_links.sql'),
  ('002_draft_upsert_index.sql'),
  ('003_comments.sql'),
  ('004_media_uploads.sql'),
  ('005_subscriptions.sql'),
  ('006_receipt_portability.sql'),
  ('007_subscription_nostr_event.sql'),
  ('008_deduplicate_articles.sql'),
  ('009_notifications.sql'),
  ('010_votes.sql'),
  ('011_store_ciphertext.sql'),
  ('012_notification_note_id.sql'),
  ('013_note_excerpt_fields.sql'),
  ('014_notification_dedup.sql'),
  ('015_access_mode_and_unlock_types.sql'),
  ('016_direct_messages.sql'),
  ('017_pledge_drives.sql'),
  ('018_add_on_delete_clauses.sql'),
  ('019_fix_notification_dedup.sql'),
  ('020_notification_routing_columns.sql'),
  ('021_missing_on_delete_clauses.sql'),
  ('022_composite_index_read_events.sql'),
  ('023_subscription_auto_renew.sql'),
  ('024_annual_subscriptions.sql'),
  ('025_comp_subscriptions.sql'),
  ('026_article_profile_pins.sql'),
  ('027_subscription_visibility.sql'),
  ('028_subscription_nudge.sql'),
  ('029_gift_links.sql'),
  ('030_commissions_expansion.sql'),
  ('031_fix_media_urls_domain.sql'),
  ('032_dm_likes.sql'),
  ('033_admin_account_ids_config.sql'),
  ('034_dm_replies.sql'),
  ('035_feed_scores.sql'),
  ('036_commission_conversation.sql'),
  ('037_subscription_offers.sql'),
  ('038_publications.sql'),
  ('039_default_article_price.sql'),
  ('040_traffology_schema.sql'),
  ('041_webhook_dedup_and_fk_fixes.sql'),
  ('042_email_on_publish.sql'),
  ('043_session_invalidation.sql'),
  ('044_email_on_publish_v2.sql'),
  ('045_article_price_mode.sql'),
  ('046_notification_preferences.sql'),
  ('047_bookmarks.sql'),
  ('048_tags.sql'),
  ('049_account_lifecycle.sql'),
  ('050_publication_layout.sql'),
  ('051_article_scheduling.sql'),
  ('052_universal_feed_external.sql'),
  ('053_feed_items.sql'),
  ('054_feed_items_backfill.sql'),
  ('055_universal_feed_atproto.sql'),
  ('056_universal_feed_activitypub.sql')
ON CONFLICT (filename) DO NOTHING;
