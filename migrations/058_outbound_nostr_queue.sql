-- =============================================================================
-- 058: Phase 5B — migrate external Nostr outbound to the outbound_posts queue
--
-- Phase 5A built outbound_posts assuming a linked_accounts row was always
-- present (Mastodon OAuth credentials). External Nostr publishing uses the
-- user's own custodial Nostr key — there is no per-platform OAuth linked
-- account. To unify the audit/retry trail, we:
--
--   - Allow linked_account_id to be NULL (nostr_external case)
--   - Persist the signed Nostr event JSON so the worker can replay it
--
-- Existing rows are unaffected.
-- =============================================================================

ALTER TABLE outbound_posts
  ALTER COLUMN linked_account_id DROP NOT NULL;

ALTER TABLE outbound_posts
  ADD COLUMN signed_event JSONB;
