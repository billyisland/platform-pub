-- Migration 053: feed_items — unified timeline table (Universal Feed Phase 2)
--
-- Denormalised timeline table that all content types write to at creation time.
-- Replaces the Phase 1 three-stream merge (articles + notes + external_items
-- queried separately, merged in application code) with a single-table scan.
--
-- See docs/adr/UNIVERSAL-FEED-ADR.md §IV.5 for full design rationale.

CREATE TABLE feed_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type         TEXT NOT NULL CHECK (item_type IN ('article', 'note', 'external')),

  -- Foreign key to the source table (exactly one is non-null)
  article_id        UUID REFERENCES articles(id) ON DELETE CASCADE,
  note_id           UUID REFERENCES notes(id) ON DELETE CASCADE,
  external_item_id  UUID REFERENCES external_items(id) ON DELETE CASCADE,

  -- Author identity (denormalised for single-query feed rendering)
  author_id         UUID REFERENCES accounts(id) ON DELETE SET NULL,  -- NULL for external
  author_name       TEXT NOT NULL,
  author_avatar     TEXT,
  author_username   TEXT,               -- NULL for external items

  -- Content preview (denormalised)
  title             TEXT,               -- article title or RSS title
  content_preview   TEXT,               -- first ~200 chars, plain text

  -- Metadata
  nostr_event_id    TEXT,               -- NULL for external
  tier              content_tier NOT NULL DEFAULT 'tier1',
  published_at      TIMESTAMPTZ NOT NULL,

  -- External-only fields
  source_protocol   TEXT,               -- 'atproto', 'activitypub', 'rss', 'nostr_external'
  source_item_uri   TEXT,               -- link to original on source platform
  source_id         UUID REFERENCES external_sources(id) ON DELETE CASCADE,
  media             JSONB,

  -- Scoring (written by the feed scoring worker)
  score             FLOAT NOT NULL DEFAULT 0,

  -- Soft delete
  deleted_at        TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Exactly one source FK must be set
  CONSTRAINT exactly_one_source CHECK (
    (article_id IS NOT NULL)::int +
    (note_id IS NOT NULL)::int +
    (external_item_id IS NOT NULL)::int = 1
  ),

  -- Native content is always tier1; external tiers are determined by protocol
  CONSTRAINT tier_consistency CHECK (
    (item_type IN ('article', 'note') AND tier = 'tier1') OR
    (item_type = 'external')
  )
);

-- Primary feed query index: compound cursor for stable pagination
CREATE INDEX idx_feed_items_cursor ON feed_items(published_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Author feed (profile pages, following feed filter)
CREATE INDEX idx_feed_items_author ON feed_items(author_id, published_at DESC)
  WHERE deleted_at IS NULL;

-- External source feed (per-source browsing, daily cap enforcement)
CREATE INDEX idx_feed_items_source ON feed_items(source_id, published_at DESC)
  WHERE source_id IS NOT NULL AND deleted_at IS NULL;

-- Explore feed (scored ranking)
CREATE INDEX idx_feed_items_score ON feed_items(score DESC, published_at DESC)
  WHERE deleted_at IS NULL;

-- Unique partial indexes: enforce one feed_items row per source row.
-- Also make the backfill migration idempotent (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX idx_feed_items_article ON feed_items(article_id)
  WHERE article_id IS NOT NULL;
CREATE UNIQUE INDEX idx_feed_items_note ON feed_items(note_id)
  WHERE note_id IS NOT NULL;
CREATE UNIQUE INDEX idx_feed_items_external ON feed_items(external_item_id)
  WHERE external_item_id IS NOT NULL;

-- Item type index for filtered queries (e.g. explore excludes external)
CREATE INDEX idx_feed_items_type ON feed_items(item_type, published_at DESC)
  WHERE deleted_at IS NULL;
