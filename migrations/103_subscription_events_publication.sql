-- Migration 103: subscription_events publication target
--
-- Publication subscriptions could never log a charge. subscription_events.writer_id
-- is NOT NULL with an FK to accounts, but a publication is not an account — and
-- both the subscribe path (routes/subscriptions/publication.ts) and the renewal
-- worker passed the publication_id into the writer_id slot, violating the FK.
-- This was latent only because no publication subscription ever reached a charge
-- (renewal previously dropped them from its SELECT; see migration 023 worker).
--
-- Add a publication_id target, relax writer_id to nullable, and require at least
-- one target. Existing rows all carry a writer_id (article reads + writer subs),
-- so the new CHECK holds for the backfill with no data change.

ALTER TABLE subscription_events
  ADD COLUMN IF NOT EXISTS publication_id uuid REFERENCES publications(id);

ALTER TABLE subscription_events
  ALTER COLUMN writer_id DROP NOT NULL;

ALTER TABLE subscription_events
  DROP CONSTRAINT IF EXISTS subscription_events_target_check;
ALTER TABLE subscription_events
  ADD CONSTRAINT subscription_events_target_check
  CHECK (writer_id IS NOT NULL OR publication_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_subscription_events_publication
  ON subscription_events (publication_id) WHERE publication_id IS NOT NULL;
