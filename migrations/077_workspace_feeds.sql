-- =============================================================================
-- 077: feeds + feed_sources — workspace experiment slice 3
--
-- Per WORKSPACE-EXPERIMENT-ADR (§3, §New). Introduces the feed object that a
-- vessel renders. A feed has an owner and an ordered set of sources (followed
-- accounts, external subscriptions, future named-audiences). Slice 3 ships
-- the schema + an empty-sources placeholder query (falls back to the user's
-- explore feed); source semantics arrive in a later slice.
--
-- Layout (vessel position, size, brightness, density, orientation) is *not*
-- here — that lives in localStorage per ADR §3 until the shape settles. This
-- migration only describes what content a vessel pulls from.
-- =============================================================================

CREATE TABLE feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Length guard — UI is a single-line input. Longer names are almost always
  -- a mistake; the cap is generous enough for any realistic title.
  CONSTRAINT feeds_name_length CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE INDEX feeds_owner_idx ON feeds (owner_id, created_at DESC);

-- feed_sources — the set of pulls that compose a feed. Slice 3 leaves this
-- table empty; the items endpoint treats no-sources as "explore" and the
-- ∀-menu *new feed* flow currently doesn't write any rows here.
--
-- source_type discriminator points at one of three native pulls or an
-- external_sources row. weight + sampling_mode are placeholder columns for
-- the eventual ranking story (see ADR §3); slice 3's items query ignores
-- both. muted_at provides a soft-disable without dropping the row.
CREATE TABLE feed_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('account', 'publication', 'external_source', 'tag')),
  -- Polymorphic FK target — populated per source_type. Exactly one of these
  -- columns is non-null on any row, enforced by the CHECK below.
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  publication_id UUID REFERENCES publications(id) ON DELETE CASCADE,
  external_source_id UUID REFERENCES external_sources(id) ON DELETE CASCADE,
  tag_name TEXT,
  weight NUMERIC NOT NULL DEFAULT 1.0,
  sampling_mode TEXT NOT NULL DEFAULT 'chronological'
    CHECK (sampling_mode IN ('chronological', 'scored', 'random')),
  muted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT feed_sources_target_matches_type CHECK (
    (source_type = 'account'         AND account_id         IS NOT NULL AND publication_id IS NULL AND external_source_id IS NULL AND tag_name IS NULL) OR
    (source_type = 'publication'     AND publication_id     IS NOT NULL AND account_id IS NULL AND external_source_id IS NULL AND tag_name IS NULL) OR
    (source_type = 'external_source' AND external_source_id IS NOT NULL AND account_id IS NULL AND publication_id IS NULL AND tag_name IS NULL) OR
    (source_type = 'tag'             AND tag_name           IS NOT NULL AND account_id IS NULL AND publication_id IS NULL AND external_source_id IS NULL)
  )
);

CREATE INDEX feed_sources_feed_idx ON feed_sources (feed_id);

-- Per-feed dedup so the same target can't be added twice. Partial indexes
-- per source_type to keep each unique key lean and to allow NULL targets in
-- inactive types without conflict.
CREATE UNIQUE INDEX feed_sources_account_uniq
  ON feed_sources (feed_id, account_id)
  WHERE source_type = 'account';
CREATE UNIQUE INDEX feed_sources_publication_uniq
  ON feed_sources (feed_id, publication_id)
  WHERE source_type = 'publication';
CREATE UNIQUE INDEX feed_sources_external_uniq
  ON feed_sources (feed_id, external_source_id)
  WHERE source_type = 'external_source';
CREATE UNIQUE INDEX feed_sources_tag_uniq
  ON feed_sources (feed_id, tag_name)
  WHERE source_type = 'tag';

-- updated_at trigger for feeds — a rename or future source-set churn bumps
-- it. feed_sources changes also bump the parent feed's updated_at; this
-- keeps the workspace's "last touched" ordering correct without requiring
-- the gateway to remember to update both rows.
CREATE OR REPLACE FUNCTION feeds_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feeds_touch_updated_at
  BEFORE UPDATE ON feeds
  FOR EACH ROW EXECUTE FUNCTION feeds_touch_updated_at();

CREATE OR REPLACE FUNCTION feed_sources_touch_parent() RETURNS TRIGGER AS $$
BEGIN
  UPDATE feeds SET updated_at = now() WHERE id = COALESCE(NEW.feed_id, OLD.feed_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feed_sources_touch_parent
  AFTER INSERT OR UPDATE OR DELETE ON feed_sources
  FOR EACH ROW EXECUTE FUNCTION feed_sources_touch_parent();
