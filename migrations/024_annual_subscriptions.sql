-- Migration 024: Annual subscription support
-- Adds subscription period tracking and writer-configurable annual discount.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscriptions') THEN
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS subscription_period TEXT NOT NULL DEFAULT 'monthly'
      CHECK (subscription_period IN ('monthly', 'annual'));
  END IF;
END $$;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS annual_discount_pct INTEGER NOT NULL DEFAULT 15
  CHECK (annual_discount_pct BETWEEN 0 AND 30);
