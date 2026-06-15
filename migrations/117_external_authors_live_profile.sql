-- 117_external_authors_live_profile.sql
--
-- Persist live-fetched external profile fields (currently Nostr kind-0 metadata)
-- onto external_authors so the hover card / profile header serve them from the DB
-- instead of paying a multi-second relay round-trip on every client cache miss.
-- The fields survive restarts and seed instantly; a stale row is re-fetched and
-- re-persisted on the next view past the TTL (gateway author.ts).
--
--   bio                → kind-0 `about`
--   website            → kind-0 `website`
--   lightning_address  → kind-0 `lud16`
--   profile_fetched_at → last successful live fetch (NULL ⇒ never fetched ⇒ stale)

ALTER TABLE external_authors
  ADD COLUMN bio                TEXT,
  ADD COLUMN website            TEXT,
  ADD COLUMN lightning_address  TEXT,
  ADD COLUMN profile_fetched_at TIMESTAMP WITH TIME ZONE;
