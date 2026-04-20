-- Migration 075: external_sources.metadata_updated_at
--
-- Tracks the created_at of the most recent kind-0 profile event we accepted
-- for a Nostr source (and the most recent actor/feed fetch for other
-- protocols). The Nostr ingest path uses this as a ratchet so a stale kind-0
-- served out-of-order by a cached relay cannot overwrite newer display
-- metadata we already have.
--
-- NULL means "no profile metadata yet" — any incoming event wins.

ALTER TABLE external_sources
  ADD COLUMN metadata_updated_at TIMESTAMPTZ;
