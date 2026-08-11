-- =============================================================================
-- 177 — the `reach` source kind is retired: Explore goes, Following becomes rows
--
-- CONSOLIDATED-TODO §9.16, ruled by the operator 2026-08-10. `source_type =
-- 'reach'` carried two things wearing one name. `reach:explore` — the
-- platform-wide ranked stream as a composable source — is deleted outright: it
-- was the one deictic, score-ranked ingredient in a model whose whole pitch is
-- "a feed is the named rows you put in it". `reach:following` is REPLACED, not
-- deleted: "everyone I follow" stops being a rule evaluated at read time and
-- becomes N concrete `account` rows the user can see, weight, mute and remove —
-- the Follow button now writes one into the feed it was pressed in (the same
-- gesture external follow has always been). Both halves land here together so
-- the column never survives with one legal value.
--
-- NO CONVERSION OF EXISTING ROWS — deliberately, on evidence. The plan held a
-- snapshot step (expand each live reach:following into one account row per
-- followee). The 2026-08-10 prod count found exactly 3 reach rows, all in the
-- operator's own test feeds ("Substack RSS", "Test"), no member holding any —
-- so the conversion was struck and this migration just deletes them. If a
-- re-count before applying shows a MEMBER row, stop and reinstate the
-- conversion (§9.16's struck bullet has the design).
--
-- DEPLOY ORDERING (§0p.2): breaking for OLD code — the previous gateway image
-- SELECTs `reach_kind` in three source queries and its addSource accepts
-- `sourceType: 'reach'` — so migrate, then deploy the new image, in that order,
-- within one deploy window (per DEPLOYMENT.md this is already the sequence).
-- New code against an unmigrated DB is unaffected (it never names the column).
--
-- The empty-vessel explore placeholder (`placeholderExploreItems`) is
-- explicitly NOT in scope (§2.7, deferred the same day): explore survives as
-- the default for a feed with zero sources, just no longer as a choice.
--
-- Dropping `reach_kind` would auto-drop every constraint/index involving it
-- (including `feed_sources_target_matches_type`, which must be REWRITTEN, not
-- lost) — so the drops are explicit, then the two surviving constraints are
-- re-added without their reach arms.
-- =============================================================================

DELETE FROM feed_sources WHERE source_type = 'reach';

ALTER TABLE feed_sources DROP CONSTRAINT feed_sources_target_matches_type;
ALTER TABLE feed_sources DROP CONSTRAINT feed_sources_source_type_check;
ALTER TABLE feed_sources DROP CONSTRAINT feed_sources_reach_kind_check;
DROP INDEX feed_sources_reach_uniq;
ALTER TABLE feed_sources DROP COLUMN reach_kind;

ALTER TABLE feed_sources ADD CONSTRAINT feed_sources_source_type_check
  CHECK (source_type = ANY (ARRAY['account'::text, 'publication'::text, 'external_source'::text, 'tag'::text]));

ALTER TABLE feed_sources ADD CONSTRAINT feed_sources_target_matches_type
  CHECK (
       ((source_type = 'account'::text) AND (account_id IS NOT NULL) AND (publication_id IS NULL) AND (external_source_id IS NULL) AND (tag_name IS NULL))
    OR ((source_type = 'publication'::text) AND (publication_id IS NOT NULL) AND (account_id IS NULL) AND (external_source_id IS NULL) AND (tag_name IS NULL))
    OR ((source_type = 'external_source'::text) AND (external_source_id IS NOT NULL) AND (account_id IS NULL) AND (publication_id IS NULL) AND (tag_name IS NULL))
    OR ((source_type = 'tag'::text) AND (tag_name IS NOT NULL) AND (account_id IS NULL) AND (publication_id IS NULL) AND (external_source_id IS NULL))
  );
