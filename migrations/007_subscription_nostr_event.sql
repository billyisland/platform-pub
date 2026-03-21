-- =============================================================================
-- Migration 007: Subscription Nostr events
--
-- Adds nostr_event_id to subscriptions so we can track the most recently
-- published kind 7003 subscription attestation event on the relay.
--
-- Kind 7003 is the provisional NIP-88 subscription event, signed by the
-- platform service key. Published on create, reactivate, and cancel.
-- The event ID stored here is the latest state transition event.
-- =============================================================================

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS nostr_event_id TEXT;
