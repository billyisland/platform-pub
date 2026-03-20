-- =============================================================================
-- Migration 005: Subscriptions
--
-- Adds:
--   1. subscription_price_pence on accounts (writer-configurable, default 500)
--   2. subscriptions table (reader ↔ writer monthly relationships)
--   3. subscription_events table (audit log for credits/debits dashboard)
--   4. Modify read_events to track subscription reads as zero-cost
-- =============================================================================

-- Writer-configurable subscription price (default £5.00)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS subscription_price_pence INTEGER NOT NULL DEFAULT 500;

-- =============================================================================
-- Subscriptions
--
-- Each row represents one reader's subscription to one writer.
-- Status lifecycle: active → cancelled → expired
--   - active: reader has access, will renew at current_period_end
--   - cancelled: reader has access until current_period_end, then expires
--   - expired: no access, subscription ended
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reader_id UUID NOT NULL REFERENCES accounts(id),
  writer_id UUID NOT NULL REFERENCES accounts(id),
  price_pence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '1 month'),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reader_id, writer_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_reader ON subscriptions(reader_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_writer ON subscriptions(writer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status) WHERE status = 'active' OR status = 'cancelled';
CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end ON subscriptions(current_period_end) WHERE status IN ('active', 'cancelled');

-- =============================================================================
-- Subscription Events — audit log for credits/debits dashboards
--
-- Types:
--   subscription_charge   — reader was charged for a month (debit for reader)
--   subscription_earning  — writer earned from a subscriber (credit for writer)
--   subscription_read     — subscriber read an article (zero-cost, logged for
--                           engagement tracking and permanent unlock)
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('subscription_charge', 'subscription_earning', 'subscription_read')),
  reader_id UUID NOT NULL REFERENCES accounts(id),
  writer_id UUID NOT NULL REFERENCES accounts(id),
  article_id UUID REFERENCES articles(id),
  amount_pence INTEGER NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_events_subscription ON subscription_events(subscription_id);
CREATE INDEX IF NOT EXISTS idx_sub_events_reader ON subscription_events(reader_id);
CREATE INDEX IF NOT EXISTS idx_sub_events_writer ON subscription_events(writer_id);
CREATE INDEX IF NOT EXISTS idx_sub_events_type ON subscription_events(event_type);
CREATE INDEX IF NOT EXISTS idx_sub_events_created ON subscription_events(created_at DESC);

-- =============================================================================
-- Track whether a read_event was via subscription (zero-cost)
-- =============================================================================

ALTER TABLE read_events ADD COLUMN IF NOT EXISTS via_subscription_id UUID REFERENCES subscriptions(id);
ALTER TABLE read_events ADD COLUMN IF NOT EXISTS is_subscription_read BOOLEAN NOT NULL DEFAULT FALSE;

-- =============================================================================
-- Permanent unlocks — track which articles a reader has unlocked
-- (by payment or by subscription read), so access survives cancellation
-- =============================================================================

CREATE TABLE IF NOT EXISTS article_unlocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reader_id UUID NOT NULL REFERENCES accounts(id),
  article_id UUID NOT NULL REFERENCES articles(id),
  unlocked_via TEXT NOT NULL CHECK (unlocked_via IN ('purchase', 'subscription', 'own_content', 'free_allowance')),
  subscription_id UUID REFERENCES subscriptions(id),
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reader_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_article_unlocks_reader ON article_unlocks(reader_id);
CREATE INDEX IF NOT EXISTS idx_article_unlocks_article ON article_unlocks(article_id);
