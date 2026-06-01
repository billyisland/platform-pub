-- Migration 101: relay-free nostr identity (UNIVERSAL-POST C1 fix)
-- ===========================================================================
-- The external-nostr adapter now encodes source_item_uri (a nevent/naddr)
-- WITHOUT relay hints. Because feed_items.post_id is derived from
-- source_item_uri (the 098 trigger) and (protocol, source_item_uri) is also the
-- ingest upsert dedup key, baking relay hints into that encoding meant:
--   (a) the SAME event fetched from two relay sources minted two post_ids (two
--       THING rows), defeating the §5 dedup-to-one; and
--   (b) a boost — which knows only the target's id/coordinate, never the relay
--       hints the THING happened to be fetched with — could never reconstruct
--       the THING's key, so nostr kind-6/16 boosts NEVER re-floated or
--       attributed their THING. (The C1 finding.)
-- The fix is adapter-side (no schema/trigger change): see
-- feed-ingest/src/tasks/feed-ingest-nostr.ts (nostrEventUri / nostrAddrUri,
-- used by both the THING path and detectNostrRepost so they cannot drift).
--
-- This migration retires the EXISTING relay-bearing nostr cache so it is rebuilt
-- relay-free. We cannot re-key existing rows in place: the relay-free id lives
-- only inside the bech32, and SQL has no nip19 decoder. Leaving them would also
-- produce visible duplicates (next poll INSERTs a fresh relay-free row beside
-- the stale relay-bearing one — different source_item_uri, so no upsert
-- conflict, different post_id, so /feed shows both). Soft-deleting them hides
-- the stale rows; the poller re-ingests current events relay-free on its next
-- cycle (external content is re-fetchable; pre-cutover nostr volume is small).
-- Native articles/notes and every other protocol are untouched.
--
-- Idempotent: re-running deletes nothing new (edges already gone; rows already
-- carry deleted_at). On a DB with no external-nostr rows (e.g. dev bootstrapped
-- from schema.sql) it is a no-op.

-- Stale boost edges: target_post_id was derived from the raw hex/coordinate and
-- never matched any THING. They cannot be recomputed (the edge persists only the
-- hash, not the source handle); correct edges re-create on the next boost ingest.
DELETE FROM repost_edges WHERE protocol = 'nostr_external';

-- Retire relay-bearing nostr THINGs; the poller rebuilds them relay-free.
UPDATE feed_items
   SET deleted_at = now()
 WHERE source_protocol = 'nostr_external'
   AND deleted_at IS NULL;

UPDATE external_items
   SET deleted_at = now()
 WHERE protocol = 'nostr_external'
   AND deleted_at IS NULL;
