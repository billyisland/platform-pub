-- =============================================================================
-- Starter template — LIVE MODE.  Run on PROD against the platformpub DB.
--
-- WHAT THIS CHANGES, AND WHY IT IS NOT THE 2026-08-10 SHAPE.
--
-- The 2026-08-10 repair (CONSOLIDATED-TODO §0l item 1) deliberately made the
-- template a SEPARATE, hidden snapshot of the operator's working feed, so that
-- editing your own feed could never silently change what new members receive.
-- That is the right shape for a platform with members on it. It is the wrong
-- shape for the month before launch, when the welcome mat is itself the thing
-- being built: under it, every improvement to the feed reaches new members only
-- when someone remembers to re-copy 70-odd rows by hand, and the two feeds drift
-- apart silently in between.
--
-- Operator ruling 2026-08-11: while the beta holds no genuine members, the
-- working feed IS the template. One feed, edited live, cloned as-is by whoever
-- signs up next. Part 4 reverses it when that stops being true.
--
-- WHAT YOU GET FOR FREE, AND WHAT YOU GIVE UP.
--
-- Free: `cloneFeedForOwner` reads the template at clone time, so a live edit is
-- a live change to the welcome mat with no re-copy step. And a flagged feed
-- cannot be deleted or merged away (both guards answer 409
-- `starter_template_source`), so your daily-driver feed becomes the one feed on
-- the site you cannot destroy by accident.
--
-- Given up: there is no longer any staging. A half-finished edit is what the
-- next signup clones, and a source you remove is gone from every future clone
-- immediately. That is the trade being made on purpose.
--
-- ALSO WORTH KNOWING: the clone is taken on first WORKSPACE LOAD, not at admit
-- time (`listFeedsForOwner` seeds for any owner with zero feeds). A member
-- admitted today who first signs in next week gets NEXT WEEK's feed.
-- =============================================================================


-- =============================================================================
-- PART 1 — READ-ONLY SURVEY.  Run all of it, read it, then do Part 2.
-- =============================================================================

-- 1a. Every feed the operator owns, with the flag. Expect exactly two rows
-- named "Billy Island's demonstration feed": the visible working feed, and the
-- hidden flagged snapshot from 2026-08-10.
-- → note the two ids. <WORKING_ID> is the VISIBLE one (hidden = false).
SELECT f.id, f.name, f.hidden, f.is_starter_template, f.sort_rank,
       (SELECT COUNT(*) FROM feed_sources fs WHERE fs.feed_id = f.id) AS sources
  FROM feeds f
  JOIN accounts a ON a.id = f.owner_id
 WHERE a.username = '<OPERATOR>'
 ORDER BY f.sort_rank, f.created_at;

-- 1b. Confirm exactly one feed on the whole platform is flagged, and that it is
-- the hidden snapshot. If this returns anything else, STOP and read §0l.
SELECT id, name, hidden FROM feeds WHERE is_starter_template;

-- 1c. THE ONE THAT MATTERS: what does the snapshot hold that the working feed
-- does not? The snapshot was copied on 2026-08-10; if the working feed has lost
-- a source since, that source is about to leave the welcome mat when the
-- snapshot is deleted in Part 3. Add anything you want to keep back into the
-- working feed FIRST, through the UI, so it goes through addSource.
-- Empty result = the working feed is a superset, nothing to do.
SELECT fs.source_type,
       COALESCE(es.source_uri, es.handle, acc.username, p.slug,
                fs.tag_name, fs.reach_kind) AS what
  FROM feed_sources fs
  LEFT JOIN external_sources es  ON es.id  = fs.external_source_id
  LEFT JOIN accounts        acc  ON acc.id = fs.account_id
  LEFT JOIN publications    p    ON p.id   = fs.publication_id
 WHERE fs.feed_id = '<TEMPLATE_ID>'
   AND NOT EXISTS (
     SELECT 1 FROM feed_sources w
      WHERE w.feed_id = '<WORKING_ID>'
        AND w.source_type = fs.source_type
        AND COALESCE(w.account_id::text,  w.publication_id::text,
                     w.external_source_id::text, w.tag_name, w.reach_kind)
          = COALESCE(fs.account_id::text, fs.publication_id::text,
                     fs.external_source_id::text, fs.tag_name, fs.reach_kind)
   )
 ORDER BY 1, 2;

-- 1d. The mirror of 1c, for information only: what the working feed has gained
-- since the snapshot. This is what new members are about to start receiving.
SELECT fs.source_type,
       COALESCE(es.source_uri, es.handle, acc.username, p.slug,
                fs.tag_name, fs.reach_kind) AS what
  FROM feed_sources fs
  LEFT JOIN external_sources es  ON es.id  = fs.external_source_id
  LEFT JOIN accounts        acc  ON acc.id = fs.account_id
  LEFT JOIN publications    p    ON p.id   = fs.publication_id
 WHERE fs.feed_id = '<WORKING_ID>'
   AND NOT EXISTS (
     SELECT 1 FROM feed_sources t
      WHERE t.feed_id = '<TEMPLATE_ID>'
        AND t.source_type = fs.source_type
        AND COALESCE(t.account_id::text,  t.publication_id::text,
                     t.external_source_id::text, t.tag_name, t.reach_kind)
          = COALESCE(fs.account_id::text, fs.publication_id::text,
                     fs.external_source_id::text, fs.tag_name, fs.reach_kind)
   )
 ORDER BY 1, 2;


-- =============================================================================
-- PART 2 — MOVE THE FLAG.  One transaction: there is never a moment with zero
-- flagged feeds, because a signup landing in that window would fall through to
-- the client's empty "Founder's feed" mint and get nothing.
-- =============================================================================

BEGIN;

  UPDATE feeds SET is_starter_template = true,  updated_at = now()
   WHERE id = '<WORKING_ID>';

  UPDATE feeds SET is_starter_template = false, updated_at = now()
   WHERE id = '<TEMPLATE_ID>';

  -- Must return exactly ONE row, and it must be <WORKING_ID>, visible.
  -- seedStarterFeeds clones EVERY flagged feed, so two rows here means every
  -- new account gets two feeds. If this is not right, ROLLBACK.
  SELECT id, name, hidden, is_starter_template FROM feeds WHERE is_starter_template;

COMMIT;


-- =============================================================================
-- PART 3 — DISPOSE OF THE OLD SNAPSHOT.  DO THIS IN THE UI, NOT IN SQL.
--
-- The snapshot is now unflagged, so `DELETE /feeds/:id` will accept it. Delete
-- it from the workspace: ∀ menu → restore the hidden feed → composer → Delete.
--
-- Why not SQL: the route tears external sources down through `removeSource`,
-- which drops the operator's `external_subscriptions` row ONLY for a source
-- leaving their last feed. Every source also sitting in the working feed keeps
-- its subscription; anything that lived only in the snapshot gets its
-- subscription properly torn down. A raw `DELETE FROM feeds` cascades
-- `feed_sources` away and leaves that subscription behind, so the source polls
-- forever with no surface left to unsubscribe it (the GC keys "orphaned" on
-- external_subscriptions). See the H6 comment in routes/feeds/crud.ts.
--
-- Verify afterwards — expect zero rows: an operator subscription whose source
-- sits in none of their feeds.
-- =============================================================================

SELECT es.id, es.protocol, COALESCE(es.source_uri, es.handle) AS what
  FROM external_subscriptions sub
  JOIN external_sources es ON es.id = sub.source_id
  JOIN accounts a ON a.id = sub.subscriber_id
 WHERE a.username = '<OPERATOR>'
   AND NOT EXISTS (
     SELECT 1 FROM feed_sources fs
       JOIN feeds f ON f.id = fs.feed_id
      WHERE f.owner_id = sub.subscriber_id
        AND fs.external_source_id = sub.source_id
   );

-- Final sanity check: this is the feed a brand-new account clones today.
SELECT f.id, f.name, f.hidden,
       (SELECT COUNT(*) FROM feed_sources fs WHERE fs.feed_id = f.id) AS sources
  FROM feeds f WHERE f.is_starter_template;


-- =============================================================================
-- PART 4 — THE REVERT.  Run this when the beta opens, or whenever live editing
-- stops being safe. It restores the 2026-08-10 shape: a hidden snapshot taken
-- from the working feed as it stands that day, flagged in the working feed's
-- place, so subsequent edits stop reaching new members.
--
-- This is `cloneFeedForOwner` done by hand, so it carries the same
-- `external_subscriptions` upsert the code does — hand-written `feed_sources`
-- rows bypass `addSource`, and a source with no subscription row is one the GC
-- will orphan out from under every feed holding it.
-- =============================================================================

BEGIN;

  INSERT INTO feeds (owner_id, name, appearance, sort_rank, hidden,
                     is_starter_template)
  SELECT w.owner_id, w.name, w.appearance,
         (SELECT COALESCE(MAX(sort_rank), 0) + 1
            FROM feeds WHERE owner_id = w.owner_id),
         true, true
    FROM feeds w WHERE w.id = '<WORKING_ID>'
  RETURNING id;   -- → <NEW_TEMPLATE_ID>

  INSERT INTO feed_sources
    (feed_id, source_type, account_id, publication_id, external_source_id,
     tag_name, reach_kind, weight, sampling_mode, exclude_replies)
  SELECT '<NEW_TEMPLATE_ID>', source_type, account_id, publication_id,
         external_source_id, tag_name, reach_kind, weight, sampling_mode,
         exclude_replies
    FROM feed_sources WHERE feed_id = '<WORKING_ID>';

  -- REQUIRED. Same upsert cloneFeedForOwner performs; the owner already holds
  -- these subscriptions from the working feed, so this is a no-op today and the
  -- correct thing the day it isn't.
  INSERT INTO external_subscriptions (subscriber_id, source_id)
  SELECT (SELECT owner_id FROM feeds WHERE id = '<NEW_TEMPLATE_ID>'),
         fs.external_source_id
    FROM feed_sources fs
   WHERE fs.feed_id = '<NEW_TEMPLATE_ID>' AND fs.source_type = 'external_source'
  ON CONFLICT (subscriber_id, source_id) DO NOTHING;

  UPDATE feeds SET is_starter_template = false, updated_at = now()
   WHERE id = '<WORKING_ID>';

  -- Exactly one row, and it must be <NEW_TEMPLATE_ID>.
  SELECT id, name, hidden, is_starter_template FROM feeds WHERE is_starter_template;

COMMIT;
