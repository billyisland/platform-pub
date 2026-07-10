-- RESOLVER-DISCOVERY-ADR §4 — known-world discovery branch (Phase 1).
--
-- GIN trigram indexes over the external identities the platform already holds
-- (external_authors minted by the ingest identity trigger, external_sources
-- minted by every add), so the resolver's free_text / platform_username
-- fallback can fuzzy-rank them (searchKnownWorld) with zero network I/O.
-- pg_trgm is already installed (search).
CREATE INDEX idx_external_authors_display_name_trgm
  ON external_authors USING gin (display_name gin_trgm_ops);
CREATE INDEX idx_external_authors_handle_trgm
  ON external_authors USING gin (handle gin_trgm_ops);
CREATE INDEX idx_external_sources_display_name_trgm
  ON external_sources USING gin (display_name gin_trgm_ops);
CREATE INDEX idx_external_sources_handle_trgm
  ON external_sources USING gin (handle gin_trgm_ops);
