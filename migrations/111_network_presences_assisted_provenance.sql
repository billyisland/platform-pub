-- 111: allow provenance='assisted' on network_presences
--
-- NETWORK-CONCIERGE-ADR Phase 2 (§6.1). The three-tier model (LINKED / ASSISTED
-- / CONCIERGE) was accepted (2026-06-10) AFTER migration 109 created the
-- provenance CHECK, which only permitted 'linked' and 'concierge'. ASSISTED —
-- where all.haus guides the user through the network's own native signup and the
-- network custodies the keys — is the default "set one up for me" path, so the
-- callback writes provenance='assisted'. The §6.1.1 build note's "no DB
-- migration needed" was wrong: the CHECK rejected it. This widens the CHECK.
--
-- Custody still branches two ways (OAuth-session vs key-custody); provenance is
-- only an origin label. See docs/adr/NETWORK-CONCIERGE-ADR.md §2, §5.2.

ALTER TABLE public.network_presences
  DROP CONSTRAINT network_presences_provenance_check;

ALTER TABLE public.network_presences
  ADD CONSTRAINT network_presences_provenance_check
    CHECK (provenance = ANY (ARRAY['linked'::text, 'assisted'::text, 'concierge'::text]));
