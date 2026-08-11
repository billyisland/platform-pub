-- =============================================================================
-- 178 — feed formulas: a feed's composition as a transmissible object
--
-- FEED-FORMULAS-ADR (accepted 2026-08-11), Phase 1. A formula is a feed's
-- source list frozen at a moment, stored by PORTABLE IDENTITY rather than by
-- local row id, given an unguessable token, and redeemable by any account into
-- an ordinary fully-owned feed. It is deliberately a different object in a
-- different table from `feeds`: §0l has fired twice — the flagged starter
-- template dragged into a merge (2026-07-22), then its hidden replacement
-- deleted as a stray duplicate (2026-08-10) — and both times for one reason,
-- that the shared thing was a `feeds` row, so it looked like a feed, so
-- somebody tidied it away. A formula has no rendering on the workspace floor.
--
-- Phase 1 is the object and the loop only. `feeds.is_starter_template` still
-- carries new-account seeding and is NOT touched here; Phase 2 cuts seeding
-- over to a designated formula and drops the flag in a LATER migration, never
-- in one step (the flag is the only thing keeping seeding alive until the
-- formula replaces it).
--
-- Sources are stored by identity, never by `external_source_id`:
-- cloneFeedForOwner can copy that FK only because template and clone are minted
-- in the same instant on the same instance. A formula is redeemed weeks later,
-- may name a source the GC has since culled, and must one day serialise
-- off-platform (D4). Redemption resolves each row through addSource's
-- (protocol, sourceUri) branch, which creates-or-finds.
--
-- Both the wire form (tag_kind/tag_value, NIP-51-set-shaped) and the local form
-- (source_type/protocol) are stored though each is derivable from the other:
-- the first is what serialises outward in Phase 4, the second is what addSource
-- consumes at redeem, and writing the mapping down once at freeze time is
-- cheaper than re-deriving it at both ends (D8).
--
-- No platform_config INSERT here — the source cap is a tuning dial and lives in
-- shared/src/db/config-defaults.sql (drift-guard Check 4a; a migration's INSERT
-- never runs on a DB booted from schema.sql, so the dial would simply be absent
-- there). No CONCURRENTLY, so this file may hold several statements.
--
-- DEPLOY ORDERING: purely additive. Old code never names these tables or the
-- new column, so either ordering is safe.
-- =============================================================================

CREATE TABLE feed_formulas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Provenance only, and never read at redeem — a formula is a snapshot, so
  -- the feed it was cut from may be renamed, recomposed or deleted without
  -- touching it. ON DELETE SET NULL is what makes the formula survive its
  -- parent feed's deletion, which is half of why D6 can retire the flag.
  source_feed_id uuid REFERENCES feeds(id) ON DELETE SET NULL,
  -- Mirrors feeds_name_length: redeem copies this straight into feeds.name.
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description    text CHECK (description IS NULL OR char_length(description) <= 500),
  appearance     jsonb NOT NULL DEFAULT '{}'::jsonb,
  token          text NOT NULL UNIQUE,
  visibility     text NOT NULL DEFAULT 'token' CHECK (visibility IN ('token', 'public')),
  is_default_seed boolean NOT NULL DEFAULT false,
  -- Frozen counts. source_count is denormalised for the listing; excluded_count
  -- CANNOT be derived, because an excluded source leaves no row behind — and it
  -- has to be reportable, since silent omission would let an author believe
  -- they had published their whole feed (D5).
  source_count   integer NOT NULL,
  excluded_count integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Revoking stops future redemptions and NOTHING else: no feed anywhere is
  -- touched, because a redeemed feed is fully owned by its redeemer (D1/D10).
  revoked_at     timestamptz,
  CONSTRAINT feed_formulas_seed_never_revoked CHECK (NOT is_default_seed OR revoked_at IS NULL)
);

-- ---------------------------------------------------------------------------
-- D11 — the designated default seed is undeletable and unrevocable.
--
-- D6 removes the FEED-shaped death of new-account seeding, but the formula
-- reintroduces three quieter ones, each of which is the §0l outage again:
-- global, delayed, and invisible from the act that caused it. The guarantees
-- live in the schema rather than in a route, because the §0l lesson is that a
-- guard on master is not a guard — a route rebuild can un-deploy one, and a
-- constraint cannot be un-deployed by anything short of another migration.
--
--   1. two designated rows, or none  → the partial unique index below
--   2. the designated row revoked    → the CHECK above
--   3. the designated row DELETED    → the trigger below, which matters most
--      for the path nobody types: feed_formulas.author_id is ON DELETE CASCADE,
--      so deleting the author's account would otherwise sweep the seed away
--      silently. The trigger turns that into a REFUSED ACCOUNT DELETION, which
--      is a loud, immediate, recoverable failure instead of a silent one that
--      lands on the next signup.
--
-- Undesignating is therefore possible only by designating a replacement (the
-- admin endpoint swaps both rows in one transaction), never by removal. The
-- zero-designated state is legal and is where we sit until Phase 2 cuts over.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX uq_feed_formulas_default_seed
  ON feed_formulas (is_default_seed) WHERE is_default_seed;

CREATE FUNCTION refuse_default_seed_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'feed_formulas row % is the designated default seed and cannot be deleted; designate a replacement first', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feed_formulas_refuse_seed_delete
  BEFORE DELETE ON feed_formulas
  FOR EACH ROW WHEN (OLD.is_default_seed)
  EXECUTE FUNCTION refuse_default_seed_delete();

CREATE INDEX idx_feed_formulas_author ON feed_formulas (author_id, created_at DESC);

CREATE TABLE feed_formula_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id  uuid NOT NULL REFERENCES feed_formulas(id) ON DELETE CASCADE,
  -- feed_sources has no ordering column, so freeze assigns position from the
  -- author's composer order (created_at, id as tiebreak — the same ORDER BY
  -- loadFeedSources already uses) and the formula page renders it.
  position    integer NOT NULL,
  -- Wire form (D8), NIP-51-set-shaped, so Phase 4's signed replaceable event is
  -- a mapping and not a re-cut: pubkey → 'p', hashtag → 't', URL → 'r'. The
  -- exact EVENT KIND is deliberately unpinned. 'a' (addressable coordinate) is
  -- allowed but unemitted in Phase 1 — a publication travels as its own
  -- `publications.nostr_pubkey` under 'p' (D4 as amended), which is what a
  -- reader of the set would follow; source_type is what disambiguates a
  -- publication's 'p' from an account's at redeem.
  tag_kind    text NOT NULL CHECK (tag_kind IN ('p', 't', 'r', 'a')),
  tag_value   text NOT NULL,
  tag_hint    text,
  -- Local form: what addSource is handed at redeem.
  source_type text NOT NULL CHECK (source_type IN ('account', 'publication', 'external_source', 'tag')),
  protocol    external_protocol,
  display_name text,
  avatar_url  text,
  -- Tuning travels: the composition IS the formula (§5). Defaults mirror
  -- feed_sources so a formula source and a feed source mean the same thing.
  weight      numeric NOT NULL DEFAULT 4.0,
  sampling_mode text NOT NULL DEFAULT 'chronological'
    CHECK (sampling_mode IN ('chronological', 'scored', 'random')),
  exclude_replies boolean NOT NULL DEFAULT false,
  -- The two forms must agree about what kind of thing this is, in both
  -- directions — a freeze that wrote 'r' for a tag would redeem as neither.
  CONSTRAINT feed_formula_sources_tag_matches_type
    CHECK ((source_type = 'tag') = (tag_kind = 't')),
  CONSTRAINT feed_formula_sources_protocol_matches_type
    CHECK ((source_type = 'external_source') = (protocol IS NOT NULL)),
  UNIQUE (formula_id, position)
);

-- Where a feed came from (D7: attribution travels, adoption counts do not).
-- ON DELETE SET NULL — revoking or deleting a formula never reaches into
-- anybody's workspace, so a redeemed feed outlives its formula intact.
-- feeds.cloned_from_feed_id is retained and no longer written for new
-- redemptions: it is the only provenance already-seeded members have.
ALTER TABLE feeds ADD COLUMN from_formula_id uuid REFERENCES feed_formulas(id) ON DELETE SET NULL;
