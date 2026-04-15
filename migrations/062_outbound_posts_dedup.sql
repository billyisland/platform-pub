-- =============================================================================
-- 062: Dedup outbound_posts
--
-- Without a uniqueness guard, a repeated enqueue (double-click on a cross-post
-- toggle, retry race, client replaying a failed request) can land two rows for
-- the same all.haus note targeting the same external account, and the worker
-- will post the reply/quote twice. The Graphile `job_key` already dedups the
-- worker side once the row exists, but it can't help if the duplicate audit
-- row has a fresh UUID → fresh job_key.
--
-- Index key:
--   (account_id, nostr_event_id, linked_account_id, action_type)
--
-- `linked_account_id` is NULL for nostr_external (migration 058) — PG15+
-- `NULLS NOT DISTINCT` treats those NULLs as equal so external-Nostr rows
-- dedupe on (account_id, nostr_event_id, action_type) alone. The enqueue
-- helpers use ON CONFLICT DO NOTHING + RETURNING id so a duplicate short-
-- circuits cleanly instead of raising out of the transaction.
-- =============================================================================

CREATE UNIQUE INDEX uniq_outbound_posts_dedup
  ON outbound_posts (account_id, nostr_event_id, linked_account_id, action_type)
  NULLS NOT DISTINCT;
