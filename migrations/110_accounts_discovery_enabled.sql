-- 110: accounts.discovery_enabled — per-user Nostr public-presence opt-in
--
-- NETWORK-CONCIERGE-ADR Phase 1 (§7). Nostr is the root identity and needs no
-- provisioning, so "go public on Nostr" is just exposing the existing discovery
-- machinery (kind 0/3/10002 + NIP-05) as a per-user switch.
--
-- Two gates now compose:
--   • DISCOVERY_PUBLISH_ENABLED (env) — operator master switch; ships the whole
--     feature dark until the mesh fan-out is configured.
--   • accounts.discovery_enabled (this column) — the user's own opt-in.
-- Both must be true before any discovery event is signed/enqueued.
--
-- Opt-IN (not "all means all" default-on): publishing your profile, relay list
-- and follow graph to the public Nostr mesh is world-readable and effectively
-- one-way for kind 0/10002, so it is off until the user chooses it. The existing
-- publish_follow_graph flag stays a finer-grained opt-OUT *within* an opted-in
-- account (kind 3 only).
--
-- See docs/adr/NETWORK-CONCIERGE-ADR.md §7.

ALTER TABLE public.accounts
  ADD COLUMN discovery_enabled boolean DEFAULT false NOT NULL;
