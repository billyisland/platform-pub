-- =============================================================================
-- Migration 002: Draft upsert support
--
-- The drafts route needs to upsert by (writer_id, nostr_d_tag) when the writer
-- is editing an existing article. This partial unique index enables ON CONFLICT
-- on non-null d-tags. Drafts for new articles (d-tag is NULL) are not
-- constrained — a writer can have multiple new-article drafts.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_writer_dtag
  ON article_drafts (writer_id, nostr_d_tag)
  WHERE nostr_d_tag IS NOT NULL;
