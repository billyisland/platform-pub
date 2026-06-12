-- 114: reach as a composable feed source + starter-feed templates
-- (FEED-RETIREMENT-PLAN Slice 3, workstreams A + B).
--
-- A — reach source kind. Legacy /feed is the only place global "following"/
-- "explore" reach lives. To retire it without dropping that capability
-- (Slice 0 decision = option (a)), reach becomes a first-class feed_sources
-- kind, composable into any vessel alongside accounts/publications/tags/
-- external sources. A reach row carries a `reach_kind` discriminator
-- ('following' | 'explore') and binds none of the four polymorphic FKs — its
-- membership is computed (follows/own/publication-follows for following;
-- recent top-level natives for explore), not a fixed target. Both feed_sources
-- CHECK constraints grow to admit it; the four existing types additionally
-- assert reach_kind IS NULL so a row is exactly one shape.
--
-- B — starter-feed templates. A brand-new account follows nobody, so a bare
-- reach:following vessel would be empty. Instead new accounts get a CLONE of an
-- operator-designated template feed (a real owned feeds row, fully editable).
-- `is_starter_template` flags which of the operator's own feeds seed new users;
-- `cloned_from_feed_id` records provenance on each clone so the UI can render
-- "cloned from <operator>'s feed". Deleting a template SET NULLs its clones'
-- provenance pointer (the clones are independent feeds and must survive).

-- ── A: reach source kind ────────────────────────────────────────────────────
ALTER TABLE feed_sources
  ADD COLUMN reach_kind text;

ALTER TABLE feed_sources
  DROP CONSTRAINT feed_sources_source_type_check,
  ADD CONSTRAINT feed_sources_source_type_check
    CHECK (source_type = ANY (ARRAY['account'::text, 'publication'::text, 'external_source'::text, 'tag'::text, 'reach'::text]));

ALTER TABLE feed_sources
  ADD CONSTRAINT feed_sources_reach_kind_check
    CHECK (reach_kind IS NULL OR reach_kind = ANY (ARRAY['following'::text, 'explore'::text]));

ALTER TABLE feed_sources
  DROP CONSTRAINT feed_sources_target_matches_type,
  ADD CONSTRAINT feed_sources_target_matches_type
    CHECK (
      (source_type = 'account' AND account_id IS NOT NULL AND publication_id IS NULL AND external_source_id IS NULL AND tag_name IS NULL AND reach_kind IS NULL)
      OR (source_type = 'publication' AND publication_id IS NOT NULL AND account_id IS NULL AND external_source_id IS NULL AND tag_name IS NULL AND reach_kind IS NULL)
      OR (source_type = 'external_source' AND external_source_id IS NOT NULL AND account_id IS NULL AND publication_id IS NULL AND tag_name IS NULL AND reach_kind IS NULL)
      OR (source_type = 'tag' AND tag_name IS NOT NULL AND account_id IS NULL AND publication_id IS NULL AND external_source_id IS NULL AND reach_kind IS NULL)
      OR (source_type = 'reach' AND reach_kind IS NOT NULL AND account_id IS NULL AND publication_id IS NULL AND external_source_id IS NULL AND tag_name IS NULL)
    );

-- One reach:following and one reach:explore per feed at most (mirrors the
-- per-type partial uniques on account/publication/external/tag).
CREATE UNIQUE INDEX feed_sources_reach_uniq
  ON feed_sources USING btree (feed_id, reach_kind)
  WHERE (source_type = 'reach'::text);

-- ── B: starter-feed templates ────────────────────────────────────────────────
ALTER TABLE feeds
  ADD COLUMN is_starter_template boolean NOT NULL DEFAULT false,
  ADD COLUMN cloned_from_feed_id uuid REFERENCES feeds(id) ON DELETE SET NULL;
