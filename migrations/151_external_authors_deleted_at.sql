-- 151_external_authors_deleted_at.sql
-- Author-level deletion tombstone (RESOLVER-DISCOVERY-ADR §8.3 amendment,
-- 2026-07-10). Item-level deletes were already honoured (nostr kind-5); the
-- entity the known-world discovery index surfaces is the AUTHOR, and nothing
-- recorded an author-level deletion — a deleted fediverse/nostr account stayed
-- a "probable" discovery candidate forever. Stamped by ingest on the signals
-- each protocol already delivers (AP actor/outbox HTTP 410 Gone; nostr kind-0
-- with deleted:true, cleared by a newer kind-0 without it); read by
-- searchKnownWorld, which excludes tombstoned authors and their source twins.
ALTER TABLE external_authors ADD COLUMN deleted_at timestamptz;
