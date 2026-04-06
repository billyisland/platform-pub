-- Publications: federated groups of writers with shared identity, paywall, and revenue pool.
-- All new columns are nullable or have defaults; fully backwards-compatible.

-- ============================================================================
-- PUBLICATIONS
-- ============================================================================

CREATE TABLE publications (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  slug                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  tagline                     TEXT,
  about                       TEXT,
  logo_blossom_url            TEXT,
  cover_blossom_url           TEXT,

  -- Nostr identity (custodial, same pattern as accounts)
  nostr_pubkey                TEXT NOT NULL UNIQUE,
  nostr_privkey_enc           TEXT NOT NULL,

  -- Reader-facing pricing (the rate card)
  subscription_price_pence    INTEGER NOT NULL DEFAULT 800,
  annual_discount_pct         INTEGER NOT NULL DEFAULT 15,
  default_article_price_pence INTEGER NOT NULL DEFAULT 20,

  -- Custom domain (Phase 4 — deferred, columns present for forward-compat)
  custom_domain               TEXT UNIQUE,
  custom_domain_verified      BOOLEAN NOT NULL DEFAULT FALSE,

  -- Theming (Phase 4 — deferred, column present for forward-compat)
  theme_config                JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_css                  TEXT,

  -- Stripe (optional — only needed for flat-fee commissions)
  stripe_connect_id           TEXT UNIQUE,
  stripe_connect_kyc_complete BOOLEAN NOT NULL DEFAULT FALSE,

  -- Status
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

-- ============================================================================
-- PUBLICATION MEMBERS
-- ============================================================================

CREATE TYPE publication_role AS ENUM (
  'editor_in_chief',
  'editor',
  'contributor'
);

CREATE TYPE contributor_type AS ENUM (
  'permanent',
  'one_off'
);

CREATE TABLE publication_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id        UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role                  publication_role NOT NULL,
  contributor_type      contributor_type NOT NULL DEFAULT 'permanent',
  title                 TEXT,
  is_owner              BOOLEAN NOT NULL DEFAULT FALSE,

  -- Payroll
  revenue_share_bps     INTEGER,

  -- Granular permissions
  can_publish           BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit_others       BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_members    BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_finances   BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_settings   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Lifecycle
  invited_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at           TIMESTAMPTZ,
  removed_at            TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_active_member
    UNIQUE (publication_id, account_id)
);

CREATE INDEX idx_pub_members_publication ON publication_members (publication_id)
  WHERE removed_at IS NULL;
CREATE INDEX idx_pub_members_account ON publication_members (account_id)
  WHERE removed_at IS NULL;

-- Exactly one owner per publication
CREATE UNIQUE INDEX idx_pub_members_one_owner
  ON publication_members (publication_id)
  WHERE is_owner = TRUE AND removed_at IS NULL;

-- ============================================================================
-- PUBLICATION INVITES
-- ============================================================================

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

-- ============================================================================
-- PUBLICATION ARTICLE SHARES (per-article revenue overrides)
-- ============================================================================

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

-- ============================================================================
-- PUBLICATION FOLLOWS
-- ============================================================================

CREATE TABLE publication_follows (
  follower_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  publication_id  UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  followed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, publication_id)
);

CREATE INDEX idx_pub_follows_publication ON publication_follows (publication_id);

-- ============================================================================
-- PUBLICATION PAYOUTS
-- ============================================================================

CREATE TABLE publication_payouts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id      UUID NOT NULL REFERENCES publications(id),
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

-- ============================================================================
-- MODIFICATIONS TO EXISTING TABLES
-- ============================================================================

-- articles: publication association and editorial pipeline
ALTER TABLE articles ADD COLUMN publication_id UUID REFERENCES publications(id);
ALTER TABLE articles ADD COLUMN publication_article_status TEXT
  CHECK (publication_article_status IN ('submitted', 'approved', 'published', 'unpublished'));
ALTER TABLE articles ADD COLUMN show_on_writer_profile BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX idx_articles_publication ON articles (publication_id)
  WHERE publication_id IS NOT NULL;

-- article_drafts: publication context
ALTER TABLE article_drafts ADD COLUMN publication_id UUID REFERENCES publications(id);

-- subscriptions: support publication subscriptions alongside writer subscriptions
ALTER TABLE subscriptions ADD COLUMN publication_id UUID REFERENCES publications(id);
ALTER TABLE subscriptions ALTER COLUMN writer_id DROP NOT NULL;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_reader_id_writer_id_key;

ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_target_check
  CHECK (num_nonnulls(writer_id, publication_id) = 1);

CREATE UNIQUE INDEX idx_subscriptions_reader_writer
  ON subscriptions (reader_id, writer_id) WHERE writer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_subscriptions_reader_publication
  ON subscriptions (reader_id, publication_id) WHERE publication_id IS NOT NULL;

-- subscription_nudge_log: publication nudges
ALTER TABLE subscription_nudge_log ADD COLUMN publication_id UUID REFERENCES publications(id);

-- feed_scores: publication article scoring
ALTER TABLE feed_scores ADD COLUMN publication_id UUID REFERENCES publications(id);
CREATE INDEX idx_feed_scores_publication ON feed_scores (publication_id, score DESC)
  WHERE publication_id IS NOT NULL;

-- platform_config: publication payout threshold
INSERT INTO platform_config (key, value, description) VALUES
  ('publication_payout_threshold_pence', '2000', 'Publication payout threshold (£20.00)');
