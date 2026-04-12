-- Migration 041: Webhook event deduplication + FK fix
--
-- 1. Adds stripe_webhook_events table for idempotent webhook processing.
--    Stripe guarantees at-least-once delivery, so the same event can arrive
--    multiple times. This table lets us detect and skip duplicates.
--
-- 2. Adds missing ON DELETE CASCADE to subscription_events.subscription_id.
--    Migration 021 fixed other FKs but missed this one.

-- Webhook deduplication table
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-clean old entries (keep 90 days). Stripe retries stop after ~3 days,
-- so 90 days gives ample margin.
CREATE INDEX idx_stripe_webhook_events_processed
  ON stripe_webhook_events(processed_at);

-- Fix: subscription_events.subscription_id missing ON DELETE clause
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscription_events') THEN
    ALTER TABLE subscription_events DROP CONSTRAINT IF EXISTS subscription_events_subscription_id_fkey;
    ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_subscription_id_fkey
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;
