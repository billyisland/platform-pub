-- 109: network_presences — unify linked + concierge satellite presences
--
-- NETWORK-CONCIERGE-ADR Phase 0. Generalises linked_accounts (existing OAuth
-- links to Bluesky/Mastodon — provenance 'linked', the user owns the account
-- and we hold an OAuth grant) into one table that ALSO holds future *concierge*
-- presences all.haus mints on the user's behalf (provenance 'concierge', secrets
-- in key-custody). The Nostr root identity stays inline on `accounts` — it is
-- the canonical identity, not a satellite, so it is never folded in here.
--
--   • provenance      — 'linked' | 'concierge'. Existing rows fold in as 'linked'.
--   • lifecycle_state — the presence's place in its provisioning arc
--                       ('provisioning' | 'active' | 'suspended' | 'deprovisioned').
--                       Outbound dispatch targets only lifecycle_state='active'
--                       AND is_valid; a boolean can't express "minted but not yet
--                       crawled" or "torn down but DID-doc tombstoned" (§5.2).
--   • handle/service_url — renamed from external_handle/instance_url to the
--                       protocol-neutral names (atproto: username.all.haus / pds_url;
--                       activitypub: @user@instance / instance_url).
--
-- One presence per (account_id, protocol) — a deliberate v1 limit (no multiple
-- personas per network); replaces the old (account_id, protocol, external_id)
-- uniqueness. The outbound_posts.linked_account_id FK auto-follows the rename.
--
-- See docs/adr/NETWORK-CONCIERGE-ADR.md §5.2.

ALTER TABLE public.linked_accounts RENAME TO network_presences;

ALTER TABLE public.network_presences RENAME COLUMN external_handle TO handle;
ALTER TABLE public.network_presences RENAME COLUMN instance_url TO service_url;

ALTER TABLE public.network_presences
  ADD COLUMN provenance text NOT NULL DEFAULT 'linked',
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'active';

ALTER TABLE public.network_presences
  ADD CONSTRAINT network_presences_provenance_check
    CHECK (provenance = ANY (ARRAY['linked'::text, 'concierge'::text])),
  ADD CONSTRAINT network_presences_lifecycle_state_check
    CHECK (lifecycle_state = ANY (ARRAY['provisioning'::text, 'active'::text,
                                         'suspended'::text, 'deprovisioned'::text]));

-- One presence per network per account (v1). Drop the old triple-key uniqueness
-- and replace it with (account_id, protocol). Safe: no account holds two rows of
-- the same protocol today.
ALTER TABLE public.network_presences DROP CONSTRAINT unique_linked_identity;
ALTER TABLE public.network_presences
  ADD CONSTRAINT network_presences_account_protocol_key UNIQUE (account_id, protocol);

-- Rename carried-over objects so the dumped schema stays self-consistent (a
-- table rename leaves these on the new table under their old names otherwise).
ALTER TABLE public.network_presences
  RENAME CONSTRAINT linked_accounts_pkey TO network_presences_pkey;
ALTER TABLE public.network_presences
  RENAME CONSTRAINT linked_accounts_account_id_fkey TO network_presences_account_id_fkey;
ALTER INDEX public.idx_linked_accounts_account RENAME TO idx_network_presences_account;
ALTER INDEX public.idx_linked_accounts_refresh RENAME TO idx_network_presences_refresh;
ALTER TRIGGER trg_linked_accounts_updated_at ON public.network_presences
  RENAME TO trg_network_presences_updated_at;
