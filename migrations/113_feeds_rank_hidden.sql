-- 113: feed rank + hide as feed character (MOBILE-LAYOUT-ADR §V/§VII, Slice 1).
--
-- The feed numeral becomes real, persisted state: desktop badges and the
-- mobile swipe order both read sort_rank under the same rule (visible feeds
-- number 1..N, hidden feeds skipped). Hide moves out of per-device
-- localStorage layout state onto the feed row — "I don't want to see this
-- feed" is true of the feed, not of one screen's arrangement of it. The
-- desktop client pushes any locally-hidden flags up once on first hydrate
-- after this lands.
--
-- Ranks are plain integers, rewritten in full on each reorder (feeds per
-- user are few; fractional keys are unjustified). Ties and post-delete gaps
-- are fine: order is ORDER BY sort_rank, created_at, id and the numeral is
-- derived 1..N client-side.

ALTER TABLE feeds
  ADD COLUMN sort_rank integer,
  ADD COLUMN hidden boolean NOT NULL DEFAULT false;

-- Backfill in created_at order per owner so nothing jumps on deploy.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY owner_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM feeds
)
UPDATE feeds
SET sort_rank = ranked.rn
FROM ranked
WHERE feeds.id = ranked.id;

ALTER TABLE feeds
  ALTER COLUMN sort_rank SET NOT NULL;
