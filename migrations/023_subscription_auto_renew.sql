-- Migration 023: Add auto_renew flag to subscriptions
-- Enables automatic renewal instead of silent expiry after 30 days.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscriptions') THEN
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT TRUE;

    -- Existing cancelled subscriptions should not auto-renew
    UPDATE subscriptions SET auto_renew = FALSE WHERE status = 'cancelled';
  END IF;
END $$;
