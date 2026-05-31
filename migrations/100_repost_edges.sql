-- Migration 100: Phase 0c — Repost edges (boost detection + cross-source dedup)
-- UNIVERSAL-POST-ADR §2.2/§5/§0.2/§10 Phase 0c: a bare repost/boost has no body,
-- so it is NOT a Post (THING) — it is an EDGE from a booster to the THING it
-- re-surfaces. This table is that edge. Detection is greenfield: every adapter
-- writes is_repost = FALSE today and repost-shaped input is dropped at the source
-- (nostr REQ omits kind 6/16; jetstream filters to app.bsky.feed.post; activitypub
-- skips Announce; getAuthorFeed skips reason). Phase 0c builds detection per
-- adapter and records each boost here. Boosts NEVER create an external_items /
-- feed_items row.
--
-- This migration is schema-only (table + indexes). Per-adapter detection lands in
-- feed-ingest TS (lib/repost-edge.ts + the four ingest paths). Phase 0c is
-- ingestion + schema only: feed assembly/ordering (§5) that consumes these edges
-- is Phase 1 and does NOT touch timeline.ts here.
--
-- Key design points:
--   • target_post_id is the boosted THING's DETERMINISTIC post_id (§2.3), computed
--     via feed_items_derive_post_id(protocol, stableOriginHandle) — the SAME
--     function migration 098 uses to mint feed_items.post_id, so an edge joins its
--     THING by post_id and two sources boosting one THING resolve to one
--     target_post_id with two edges (the §5 cross-source dedup). It is NOT an FK:
--     the THING may not be ingested yet, and post_id is not unique on feed_items
--     (one row per source THING, but several edges/boosts may target it).
--   • actor_handle is the booster's stable origin handle (nostr pubkey / atproto
--     DID / activitypub actor URI) — always present, drives the §5 attribution line.
--     actor_external_author_id lazily links to external_authors when that booster is
--     already a known external author (no minting here — a pure booster who never
--     authored anything we ingested has no external_authors row; that link fills in
--     later, "mint eagerly, bind lazily" §2.1).
--   • boosted_at is the BOOST time (drives §5 recency + re-float), never the
--     original THING's publish time.
--   • trust_weight is hard-coded 1 until the trust graph lands (§9).
--   • origin_uri is the boost object's OWN origin id (kind-6/16 event id, atproto
--     repost record uri, activitypub Announce id) — kept here, never minted as a
--     node. It is the natural idempotency key where the protocol exposes it.

CREATE TABLE repost_edges (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol                 external_protocol NOT NULL,
  target_post_id           text NOT NULL,        -- feed_items_derive_post_id(...) of the boosted THING
  actor_handle             text NOT NULL,        -- booster pubkey | DID | actor URI
  actor_external_author_id uuid REFERENCES external_authors(id) ON DELETE SET NULL,
  trust_weight             numeric NOT NULL DEFAULT 1,   -- §9: hard-coded 1 until trust graph
  boosted_at               timestamptz NOT NULL,         -- the boost time, not the original's publish time
  origin_uri               text,                 -- the boost object's own origin id (where exposed)
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- ── idempotency ──────────────────────────────────────────────────────────────
-- Where the protocol exposes the boost's own id (atproto repost record, AP
-- Announce id, nostr kind-6/16 event id), (protocol, origin_uri) dedups re-ingest.
-- Where it does not, fall back to (protocol, target_post_id, actor_handle): one
-- booster boosting one THING is recorded once. Both are partial so the two regimes
-- never collide.
CREATE UNIQUE INDEX idx_repost_edges_origin
  ON repost_edges (protocol, origin_uri) WHERE origin_uri IS NOT NULL;
CREATE UNIQUE INDEX idx_repost_edges_synthetic
  ON repost_edges (protocol, target_post_id, actor_handle) WHERE origin_uri IS NULL;

-- ── assembly indexes ─────────────────────────────────────────────────────────
-- Phase 1 groups edges by target_post_id (one card per THING, attribution set).
-- The edge → THING join keys on feed_items.post_id, already indexed by migration
-- 098 (idx_feed_items_post_id), so no feed_items index is added here.
CREATE INDEX idx_repost_edges_target ON repost_edges (target_post_id);
CREATE INDEX idx_repost_edges_actor_author ON repost_edges (actor_external_author_id);
