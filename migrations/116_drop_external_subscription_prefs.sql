-- 116_drop_external_subscription_prefs.sql
--
-- External subscriptions are now FEED-DERIVED: a row in external_subscriptions
-- exists iff the source sits in >=1 of the owner's feeds, maintained by
-- addSource/removeSource in gateway/src/routes/feeds.ts. The standalone
-- Subscriptions manager (subscribe/unsubscribe/mute/refresh/list) was retired,
-- and per-subscription mute/daily-cap with it — per-feed mute now lives on
-- feed_sources.muted_at. This migration:
--   1. retracts the published kind-3 follow list for owners losing floating
--      nostr follows,
--   2. deletes legacy "floating" subscriptions (no backing feed membership),
--   3. orphans any source thereby left with no subscriber, and
--   4. drops the now-meaningless prefs columns.

-- 1) Mark the kind-3 follow list dirty for any opted-in owner whose floating
--    nostr_external subscriptions we're about to remove (mirrors the gate in
--    discovery-publish.ts::markFollowListDirty) so the next discovery sweep
--    republishes and retracts them.
UPDATE accounts a
   SET follow_list_dirty = TRUE
 WHERE a.status = 'active'
   AND a.discovery_enabled = TRUE
   AND a.publish_follow_graph = TRUE
   AND EXISTS (
     SELECT 1
       FROM external_subscriptions es
       JOIN external_sources src ON src.id = es.source_id
      WHERE es.subscriber_id = a.id
        AND src.protocol = 'nostr_external'
        AND NOT EXISTS (
          SELECT 1
            FROM feed_sources fs
            JOIN feeds f ON f.id = fs.feed_id
           WHERE f.owner_id = es.subscriber_id
             AND fs.external_source_id = es.source_id
        )
   );

-- 2) Delete floating subscriptions — those with no backing feed membership.
DELETE FROM external_subscriptions es
 WHERE NOT EXISTS (
   SELECT 1
     FROM feed_sources fs
     JOIN feeds f ON f.id = fs.feed_id
    WHERE f.owner_id = es.subscriber_id
      AND fs.external_source_id = es.source_id
 );

-- 3) Orphan any source now left with no subscriber (GC deactivates/culls later).
UPDATE external_sources
   SET orphaned_at = now()
 WHERE orphaned_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM external_subscriptions es WHERE es.source_id = external_sources.id
   );

-- 4) Drop the now-meaningless per-subscription preference columns.
ALTER TABLE external_subscriptions
  DROP COLUMN is_muted,
  DROP COLUMN daily_cap;
