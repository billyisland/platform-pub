-- 137_external_source_handle.sql
--
-- Fix the "EXTERNAL" byline bug for Bluesky (atproto) posts.
--
-- The atproto ingest (feed-ingest) never captured a per-post author identity:
-- it hard-coded external_items.author_handle = NULL and derived author_name
-- solely from external_sources.display_name. A Jetstream commit carries only
-- the author's DID (no handle/name inline), and one atproto source = exactly
-- one author, so the source row is where the account's handle belongs — but the
-- column didn't exist. When an account had no display name (Bluesky displayName
-- is optional), the byline fell through name → handle → sourceName to the
-- literal "External", rendered uppercase as "EXTERNAL".
--
-- This migration adds external_sources.handle and re-enqueues the backfill for
-- every active atproto source. The companion code change teaches the backfill to
-- resolve + persist the handle onto the source, attribute live posts from it, and
-- REPAIR the historical null author rows (external_items / external_authors /
-- feed_items). Inert on a fresh/from-schema.sql DB (no atproto sources ⇒ the
-- enqueue matches nothing).

ALTER TABLE external_sources
  ADD COLUMN IF NOT EXISTS handle text;

-- Re-run the (now enrichment-aware) backfill for existing atproto sources so
-- their handle is resolved and their historical nameless items are healed.
-- Guarded on graphile_worker being installed (it always is in a running stack;
-- the guard just keeps the migration safe if applied before the worker's schema
-- exists). Same job_key as the subscribe path, so a pending job is replaced,
-- not duplicated.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'graphile_worker' AND p.proname = 'add_job'
  ) THEN
    PERFORM graphile_worker.add_job(
      'feed_ingest_atproto_backfill',
      json_build_object('sourceId', id::text),
      job_key := 'feed_ingest_' || id::text,
      max_attempts := 1
    )
    FROM external_sources
    WHERE protocol = 'atproto' AND is_active = TRUE;
  END IF;
END $$;
