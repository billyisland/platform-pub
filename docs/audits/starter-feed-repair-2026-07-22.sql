-- =============================================================================
-- Starter-template feed repair — run on PROD against the platformpub DB.
--   docker exec -i <postgres-container> psql -U platformpub -d platformpub
-- Part 1 is read-only. Stop, read, then pick the matching repair in Part 2.
-- =============================================================================

-- ── 1a. Is any template still flagged? ──────────────────────────────────────
-- Empty result = the template feed is GONE (it was the dragged/source feed in
-- the merge, and POST /feeds/:id/merge deletes the source feed). New signups
-- are getting no starter feed at all.
SELECT f.id, f.name, f.owner_id, a.username AS owner, f.hidden, f.created_at,
       (SELECT COUNT(*) FROM feed_sources fs WHERE fs.feed_id = f.id) AS sources
  FROM feeds f
  LEFT JOIN accounts a ON a.id = f.owner_id
 WHERE f.is_starter_template;

-- ── 1b. Every feed you own, with its source-set size ────────────────────────
-- Replace <OPERATOR> with your username. The bloated feed is the merge target.
SELECT f.id, f.name, f.sort_rank, f.hidden, f.is_starter_template,
       f.cloned_from_feed_id,
       COUNT(fs.id)                                        AS sources,
       COUNT(*) FILTER (WHERE fs.source_type = 'reach')     AS reach,
       COUNT(*) FILTER (WHERE fs.source_type = 'tag')       AS tags,
       COUNT(*) FILTER (WHERE fs.source_type = 'external_source') AS externals,
       COUNT(*) FILTER (WHERE fs.source_type = 'account')   AS accounts_
  FROM feeds f
  JOIN accounts a ON a.id = f.owner_id
  LEFT JOIN feed_sources fs ON fs.feed_id = f.id
 WHERE a.username = '<OPERATOR>'
 GROUP BY f.id
 ORDER BY f.sort_rank;

-- ── 1c. The broken feed's sources, clustered by created_at ──────────────────
-- feed_sources.created_at SURVIVES a merge (the merge only UPDATEs feed_id),
-- so the two original feeds show up as two distinct timestamp clusters. This is
-- how you tell which rows came from the template.
SELECT id, source_type, reach_kind, tag_name, account_id, external_source_id,
       weight, sampling_mode, muted_at, created_at
  FROM feed_sources
 WHERE feed_id = '<BROKEN_FEED_ID>'
 ORDER BY created_at, source_type;

-- ── 1d. Confirm it's a timeout, not a crash ─────────────────────────────────
-- The pool sets statement_timeout = 10s (shared/src/db/client.ts:24). Time the
-- real query shape; if this takes >10s, that is exactly your "won't load".
\timing on
SELECT COUNT(*) FROM feed_items fi
  LEFT JOIN articles a ON a.id = fi.article_id
  JOIN feed_sources fs ON fs.feed_id = '<BROKEN_FEED_ID>' AND fs.muted_at IS NULL
   AND ( (fs.source_type='account'  AND fs.account_id = fi.author_id)
      OR (fs.source_type='publication' AND fs.publication_id = a.publication_id)
      OR (fs.source_type='external_source' AND fs.external_source_id = fi.source_id)
      OR (fs.source_type='tag' AND EXISTS (
            SELECT 1 FROM article_tags aj JOIN tags t ON t.id = aj.tag_id
             WHERE aj.article_id = fi.article_id AND t.name = fs.tag_name))
      OR (fs.source_type='reach' AND fs.reach_kind='explore'
          AND fi.published_at > now() - INTERVAL '48 hours'
          AND fi.item_type IN ('article','note')) )
 WHERE fi.deleted_at IS NULL;
\timing off

-- ── 1e. Do surviving CLONES of the old template still exist? ────────────────
-- If the template was deleted, every clone's cloned_from_feed_id was SET NULL
-- (migration 114's FK), so provenance is gone — but the clones themselves are
-- intact copies of the template's source set. Match them by name.
SELECT f.id, f.name, a.username AS owner, f.created_at,
       (SELECT COUNT(*) FROM feed_sources fs WHERE fs.feed_id = f.id) AS sources
  FROM feeds f JOIN accounts a ON a.id = f.owner_id
 WHERE f.name = '<TEMPLATE_NAME>'
 ORDER BY f.created_at
 LIMIT 20;


-- =============================================================================
-- PART 2 — REPAIRS.  Run inside a transaction; inspect, then COMMIT.
-- =============================================================================

-- ── CASE A: template survived as the merge TARGET, just over-stuffed ────────
-- Trim it back to the intended source set. Use the created_at cluster from 1c
-- to identify the rows that arrived from the other feed.
BEGIN;
  -- Preview first:
  SELECT id, source_type, reach_kind, tag_name, created_at
    FROM feed_sources
   WHERE feed_id = '<TEMPLATE_ID>'
     AND created_at > '<CUTOFF_TIMESTAMP>';   -- the newer cluster

  -- Option 1 — move them into a new feed of their own (recommended: nothing lost).
  INSERT INTO feeds (owner_id, name, sort_rank)
  SELECT owner_id, '<RECOVERED_FEED_NAME>',
         (SELECT COALESCE(MAX(sort_rank),0)+1 FROM feeds WHERE owner_id = f.owner_id)
    FROM feeds f WHERE f.id = '<TEMPLATE_ID>'
  RETURNING id;   -- → <NEW_FEED_ID>

  UPDATE feed_sources SET feed_id = '<NEW_FEED_ID>'
   WHERE feed_id = '<TEMPLATE_ID>' AND created_at > '<CUTOFF_TIMESTAMP>';

  -- Option 2 — they were junk, just drop them:
  -- DELETE FROM feed_sources
  --  WHERE feed_id = '<TEMPLATE_ID>' AND created_at > '<CUTOFF_TIMESTAMP>';
COMMIT;

-- ── CASE B: template was the merge SOURCE and is gone ───────────────────────
-- B1 (cheapest): if the surviving target IS the feed you want everyone to start
-- with, just flag it. Nothing else is needed — seedStarterFeeds clones whatever
-- carries the flag.
UPDATE feeds SET is_starter_template = true WHERE id = '<FEED_ID>';

-- B2: rebuild the template from a surviving clone (from 1e). The clone is a
-- verbatim copy of the old template's sources, weights and sampling modes.
BEGIN;
  INSERT INTO feeds (owner_id, name, appearance, sort_rank, is_starter_template)
  SELECT '<OPERATOR_ACCOUNT_ID>', c.name, c.appearance,
         (SELECT COALESCE(MAX(sort_rank),0)+1 FROM feeds WHERE owner_id = '<OPERATOR_ACCOUNT_ID>'),
         true
    FROM feeds c WHERE c.id = '<CLONE_FEED_ID>'
  RETURNING id;   -- → <NEW_TEMPLATE_ID>

  INSERT INTO feed_sources
    (feed_id, source_type, account_id, publication_id, external_source_id,
     tag_name, reach_kind, weight, sampling_mode, exclude_replies)
  SELECT '<NEW_TEMPLATE_ID>', source_type, account_id, publication_id,
         external_source_id, tag_name, reach_kind, weight, sampling_mode,
         exclude_replies
    FROM feed_sources WHERE feed_id = '<CLONE_FEED_ID>';

  -- REQUIRED — keep the feed-derived-subscription invariant. Hand-inserted
  -- feed_sources rows bypass addSource(), and a feed_sources row with no
  -- external_subscriptions row lets the GC orphan an in-use source.
  INSERT INTO external_subscriptions (subscriber_id, source_id)
  SELECT '<OPERATOR_ACCOUNT_ID>', fs.external_source_id
    FROM feed_sources fs
   WHERE fs.feed_id = '<NEW_TEMPLATE_ID>' AND fs.source_type = 'external_source'
  ON CONFLICT (subscriber_id, source_id) DO NOTHING;

  UPDATE external_sources SET is_active = TRUE, orphaned_at = NULL, updated_at = now()
   WHERE id IN (SELECT external_source_id FROM feed_sources
                 WHERE feed_id = '<NEW_TEMPLATE_ID>' AND source_type = 'external_source');
COMMIT;

-- ── CASE C: only ONE template may be flagged, or every new user gets N feeds ─
-- seedStarterFeeds clones EVERY flagged feed. Verify the count is what you want:
SELECT COUNT(*) FROM feeds WHERE is_starter_template;

-- ── Sanity check: a brand-new account would clone this ──────────────────────
SELECT f.id, f.name,
       (SELECT COUNT(*) FROM feed_sources fs WHERE fs.feed_id = f.id) AS sources
  FROM feeds f WHERE f.is_starter_template
 ORDER BY f.created_at, f.id;
