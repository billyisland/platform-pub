-- 108: Nostr outbound interop — public-content discoverability
--
-- Adds the three replaceable discovery events (kind 0/3/10002) to the relay
-- outbox entity-type universe, and per-account state driving their (re)publish:
--   • publish_follow_graph — user-facing opt-out for kind 3 (NIP-02 follow
--     list). Default ON ("all means all"); a settings toggle flips it. When
--     false, the follow-list publisher no-ops and never emits a kind 3.
--   • follow_list_dirty    — coalescing marker. A follow/unfollow sets it; the
--     gateway scheduler sweep rebuilds the kind 3 from current DB state once
--     per cycle, collapsing a burst of N actions into one signed event.
--   • discovery_synced_at  — last time kind 0/3/10002 were (re)enqueued by the
--     backfill/self-heal sweep. NULL = never published; the sweep targets
--     NULL/oldest rows so a fresh deploy backfills everyone and a missed-mesh
--     pubkey re-converges without user action.
--
-- See docs/adr/NOSTR-OUTBOUND-INTEROP-ADR.md.

ALTER TABLE public.relay_outbox
  DROP CONSTRAINT relay_outbox_entity_type_check,
  ADD CONSTRAINT relay_outbox_entity_type_check CHECK ((entity_type = ANY (ARRAY[
    'article'::text,
    'article_deletion'::text,
    'note'::text,
    'note_deletion'::text,
    'subscription'::text,
    'receipt'::text,
    'drive'::text,
    'drive_deletion'::text,
    'signing_passthrough'::text,
    'conversation_pulse'::text,
    'account_deletion'::text,
    'profile'::text,
    'follow_list'::text,
    'relay_list'::text
  ])));

ALTER TABLE public.accounts
  ADD COLUMN publish_follow_graph boolean DEFAULT true NOT NULL,
  ADD COLUMN follow_list_dirty boolean DEFAULT false NOT NULL,
  ADD COLUMN discovery_synced_at timestamp with time zone;

-- Partial index for the scheduler sweep's "least-recently-synced active
-- account with a pubkey" scan and its "any dirty follow lists" drain.
CREATE INDEX accounts_discovery_sweep_idx
  ON public.accounts (discovery_synced_at NULLS FIRST)
  WHERE status = 'active'::public.account_status;

CREATE INDEX accounts_follow_list_dirty_idx
  ON public.accounts (id)
  WHERE follow_list_dirty;
