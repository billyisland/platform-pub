-- 118_drop_feed_items_tier.sql
--
-- Architecture-audit 2026-06-15 item 2 (A) — denormalisation tidy.
--
-- Drop the dead `feed_items.tier` column (content_tier enum, tier1–4) left
-- behind by migrations 098/099. It was written on every feed_items insert
-- ('tier1' for native rows, the source's ei.tier for external) but **never
-- read**: the feed SELECT pulled `fi.tier` yet post-mapper.ts ignored it, and
-- nothing ever ordered or filtered by it. The live tier axis on feed_items is
-- `biddability_tier` (A/B/C/D), minted by the 098 identity trigger — untouched.
--
-- Its `tier_consistency` CHECK only pinned native rows to 'tier1'; drop it first
-- (it references the column). The `content_tier` enum stays — articles.tier,
-- notes.tier and (live) external_items.tier still use it.
--
-- The matching write/read sites were removed in the same change: feed-sql.ts
-- FEED_SELECT and every `INSERT INTO feed_items (... tier ...)` across the
-- gateway publish/scheduler/notes/external paths and the feed-ingest adapters.

ALTER TABLE feed_items DROP CONSTRAINT IF EXISTS tier_consistency;
ALTER TABLE feed_items DROP COLUMN IF EXISTS tier;
