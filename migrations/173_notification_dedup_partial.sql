-- =============================================================================
-- 173 — the dedup index becomes partial, which migration 019 already decided
--
-- Migration 019 made `idx_notifications_dedup` partial (`WHERE read = false`)
-- so that reading a notification frees its unique slot and the next occurrence
-- of the same event can notify again. That effect has never been in force on
-- any database, including production. `schema.sql` is the genesis file every DB
-- is built from, and it carries the NON-partial form; because schema.sql also
-- seeds `_migrations` with every filename, migrate.ts skips 019 forever. So the
-- bug 019 was written to fix — "repeat events silently fail to notify" — has
-- been live the whole time, and no check could see it: the index name is
-- present in schema.sql with a different definition, so drift-guard Check 3's
-- name-grep passes, and Checks 0/1/2 pass by construction.
--
-- Found 2026-08-05 while auditing migration 172, which deliberately rebuilt the
-- index from the LIVE definition rather than 019's, so that restoring the
-- partial clause would be its own decision rather than something smuggled in.
-- This is that decision.
--
-- WHAT IT CHANGES. Every `INSERT INTO notifications` in the codebase is a bare
-- `ON CONFLICT DO NOTHING` with no inference target, so this index alone decides
-- which notifications collapse. Against the twenty insert sites:
--
--   * No change (6 types) — they already carry a reference column unique to the
--     event, so the index never collides: new_reply (the reply's own
--     comment_id), new_quote and note-borne new_mention (the new note's id),
--     subscription_offer (offer_id), tribute_offer_received (article_id),
--     pledge_fulfilled (NULL actor, see below).
--
--   * Fixed (8 types) — deduped on (recipient, actor, type) alone, so each is
--     currently ONE notification EVER: new_follower, new_subscriber (three
--     sites), pub_new_subscriber, comp_subscription, pub_invite_received,
--     pub_member_joined, pub_member_left. A reader who subscribes, cancels and
--     resubscribes is announced to the writer once; a writer re-inviting
--     someone who declined can never tell them. Also new_mention raised from
--     replies.ts, which keys on the TARGET being replied to rather than the
--     reply, so a second mention of you in one thread is dropped today.
--
--   * Narrowed, not fixed (2 sites) — `commission_request` and `drive_funded`
--     carry no ON CONFLICT at all, so a collision raises 23505; drive_funded's
--     sits inside the pledge transaction and aborts it. Both are behind
--     PLEDGES_ENABLED and want their own fix; the partial clause only shrinks
--     the window.
--
-- The ceiling is bounded and is the property worth having: AT MOST ONE UNREAD
-- notification per (recipient, actor, type, targets). Read rows accumulate,
-- which is already true of the table generally.
--
-- WHAT IS DELIBERATELY NOT RESTORED. 019 also wrapped `actor_id` in
-- COALESCE(actor_id, sentinel). The live index leaves it bare, so NULL actors
-- never collide — and `pledge_fulfilled` is the one actor-less type, meaning
-- 019's COALESCE would tell a reader ONCE EVER that any drive they backed was
-- fulfilled, across all drives. The live definition is right about that, so
-- only the WHERE clause comes back. 019 is not restored; it is superseded.
--
-- SAFE ON EXISTING DATA by construction: a partial unique index constrains a
-- subset of the rows the full unique index already constrains, so a table that
-- satisfies the current index necessarily satisfies this one. No de-duplication
-- pass is needed (migration 014 needed one; widening never does).
--
-- Not CONCURRENTLY: multi-statement, which the runner refuses for CONCURRENTLY.
-- The table is small and the brief write lock is acceptable.
-- =============================================================================

DROP INDEX IF EXISTS idx_notifications_dedup;

CREATE UNIQUE INDEX idx_notifications_dedup
  ON notifications (
    recipient_id,
    actor_id,
    type,
    COALESCE(article_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(note_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(comment_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(offer_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE read = false;

COMMENT ON INDEX idx_notifications_dedup IS
  'At most one UNREAD notification per (recipient, actor, type, targets). Reading a notification frees its slot so the next occurrence of the same event notifies again — migration 019''s intent, in force from 173. Every INSERT INTO notifications is a bare ON CONFLICT DO NOTHING, so this index alone decides what collapses.';
