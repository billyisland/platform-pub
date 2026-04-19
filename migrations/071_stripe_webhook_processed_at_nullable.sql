-- Migration 071: Make stripe_webhook_events.processed_at nullable
--
-- Previously the dedup row was inserted with processed_at=now() before the
-- handler ran. If the process crashed between INSERT and handler completion,
-- the dedup row survived and the next Stripe retry would hit ON CONFLICT and
-- ack the event without re-running the handler — silent event loss.
--
-- Nullable processed_at lets the INSERT claim the event (proof of receipt)
-- while deferring the "this event has been fully handled" marker to after
-- the handler returns. Dedup now checks processed_at IS NOT NULL.

ALTER TABLE stripe_webhook_events ALTER COLUMN processed_at DROP DEFAULT;
ALTER TABLE stripe_webhook_events ALTER COLUMN processed_at DROP NOT NULL;

-- A "received_at" column records unconditional receipt for observability —
-- the existing processed_at index stays valid (NULL values are excluded).
ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT now();
