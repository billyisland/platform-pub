-- Migration 106: seed feed_ingest_max_enqueue_per_tick (audit C2 follow-up)
--
-- Commit 602d7d7 decoupled the per-tick poll enqueue cap from runner concurrency
-- and intended a default of 100 (= the source SELECT LIMIT, i.e. enqueue every due
-- source each tick). feed-ingest-poll.ts resolves the cap as:
--   max_enqueue_per_tick || max_concurrent || 100
-- But `feed_ingest_max_enqueue_per_tick` was never seeded, while
-- `feed_ingest_max_concurrent` IS seeded at '10' (migration 052). So on any DB
-- that ran 052, the fallback resolves to 10 and the intended ceiling lift is
-- inert — RSS/activitypub sources past ~50 fall behind and feeds go stale.
--
-- Seed the new key to 100 so the decoupling actually takes effect. Idempotent;
-- ON CONFLICT DO NOTHING leaves an operator's explicit override untouched.

INSERT INTO platform_config (key, value, description)
VALUES (
  'feed_ingest_max_enqueue_per_tick',
  '100',
  'Max sources enqueued per poll tick (decoupled from runner concurrency; = source SELECT LIMIT)'
)
ON CONFLICT (key) DO NOTHING;
