-- Migration 025: Comp (complimentary) subscriptions
-- Writers can grant free subscriptions to readers.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscriptions') THEN
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS is_comp BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;
