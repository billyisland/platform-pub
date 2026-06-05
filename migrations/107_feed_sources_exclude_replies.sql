-- 107: Per-source "no replies" mode for workspace feeds
--
-- When set, a feed source contributes only freestanding posts (root
-- announcements) — items that are replies to something else are dropped for
-- that source. The feed query gates on feed_items.is_reply (migration 097),
-- which is denormalised across native notes and external items alike.
--
-- Default false keeps existing behaviour: a source contributes everything it
-- matches. (Native note replies remain globally excluded from feeds regardless;
-- this flag is what additionally suppresses external replies per source.)

ALTER TABLE feed_sources
  ADD COLUMN exclude_replies BOOLEAN NOT NULL DEFAULT FALSE;
