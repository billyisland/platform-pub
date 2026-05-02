-- =============================================================================
-- 081: article cover images — workspace experiment slice 23b
--
-- Slice 23 lit up media on note + external cards via feed_items.media (already
-- populated by feed-ingest adapters and a client-side regex on note content).
-- Articles were deferred — there was no canonical column for an article's
-- cover image. The legacy reader scraped the first inline ![alt](url) from
-- markdown as a hero, but that's implicit, not authored, and it doesn't
-- round-trip through edit / draft state.
--
-- This migration adds an explicit cover_image_url column to articles and
-- article_drafts. Nullable: most existing articles have no explicit cover and
-- the reader keeps the inline-image scrape as a fallback so legacy articles
-- still get a hero. Drafts carry the same column so a scheduled-publish keeps
-- the cover on round-trip through the scheduler.
--
-- The NIP-23 image tag (["image", "<url>"]) is emitted by the gateway and the
-- web publish helper when this column is set. feed_items.media is dual-written
-- with a single {type:'image', url} entry so the workspace's MediaBlock
-- consumes article covers without translation — same shape as external_items.
-- =============================================================================

ALTER TABLE articles ADD COLUMN cover_image_url TEXT;
ALTER TABLE article_drafts ADD COLUMN cover_image_url TEXT;
