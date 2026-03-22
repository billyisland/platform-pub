-- =============================================================================
-- Migration 003: Comments system
-- Adds: comments table, comments_enabled columns, article soft-delete
-- =============================================================================

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  nostr_event_id    TEXT NOT NULL UNIQUE,
  target_event_id   TEXT NOT NULL,
  target_kind       INT NOT NULL,
  parent_comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comments_target
  ON comments(target_event_id, published_at ASC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

-- Author comment controls
ALTER TABLE articles ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Article soft-delete support
ALTER TABLE articles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
