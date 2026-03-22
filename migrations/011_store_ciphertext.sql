-- =============================================================================
-- Migration 011: Store encrypted ciphertext in vault_keys
--
-- Root cause: The encrypted paywall body (ciphertext) was only stored in the
-- NIP-23 kind 30023 event on the relay, as a ['payload', ciphertext, algorithm]
-- tag. If the v2 event (with the payload tag) failed to publish to the relay —
-- for example due to a stale NDK WebSocket connection — the ciphertext was lost.
-- The database pointed to v2's event ID, but the relay only had v1 (no payload).
-- Readers clicking the paywall gate got "Could not find the encrypted content."
--
-- Fix: Store the ciphertext alongside the content key in vault_keys. The
-- gate-pass response now includes the ciphertext directly, so the reader
-- never needs to find it on the relay. This also makes the paywall pipeline
-- resilient to relay outages and simplifies future federation (the ciphertext
-- can be served from the DB without depending on relay availability).
-- =============================================================================

ALTER TABLE vault_keys
  ADD COLUMN ciphertext TEXT;

-- Backfill note: Existing articles that were published before this migration
-- have their ciphertext only in the relay's NIP-23 event. A backfill script
-- can fetch these from the relay and populate the column. Articles whose v2
-- never reached the relay (the bug this fixes) will need to be re-published
-- by the writer — the content key still exists, so the writer can edit and
-- re-publish to regenerate the ciphertext.
