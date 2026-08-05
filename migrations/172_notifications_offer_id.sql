-- =============================================================================
-- 172 — notifications.offer_id, and the dedup index that has to know about it
--
-- Migration 171 gave grant-mode subscription offers a code, and the create route
-- notifies the named recipient that a gift exists. But the notification had
-- nowhere to put WHICH offer: `notifications` carries a dedicated nullable
-- reference per linkable entity (article_id, comment_id, note_id,
-- conversation_id, drive_id) and there was none for an offer. So the row could
-- not be rendered as a link, and the recipient saw an unlabelled "sent you a
-- notification" pointing at nothing — while the whole reason the redeem lookup
-- 401s a logged-out visitor rather than 404ing them is "the recipient arriving
-- from their notification". That path did not exist (audit 2026-08-05).
--
-- ON DELETE CASCADE, matching the other reference columns: an offer is normally
-- REVOKED (a soft `revoked_at`), so this only fires on a genuine hard delete,
-- where a notification pointing at a row that is gone is worse than no
-- notification.
--
-- THE DEDUP INDEX HAS TO BE REBUILT, and that is the substance of this
-- migration rather than an afterthought. `idx_notifications_dedup` is UNIQUE
-- over (recipient, actor, type, article, note, comment) with the NULL
-- references COALESCEd to a sentinel — so two grants from the same writer to
-- the same reader are, to that index, the same notification: all three
-- reference columns are NULL in both. Every INSERT INTO notifications in the
-- codebase uses a bare `ON CONFLICT DO NOTHING` (22 sites, none naming an
-- inference target), so the second grant was silently dropped, and DO NOTHING
-- meant an already-read first notification was not even reopened. A writer
-- sending a better gift to the same reader would never be able to tell them.
-- Adding the column to the index makes two offers two notifications.
--
-- Rebuilt with the LIVE definition plus the new column, deliberately NOT with
-- migration 019's. 019 made this index partial (`WHERE read = false`) so that a
-- read notification frees its slot, but schema.sql — the genesis file every
-- database is actually built from — carries the non-partial form, so 019's
-- effect has never been in force on any real DB and the partial behaviour would
-- be a NEW change smuggled in here. It is worth having and it is not this
-- migration's business; recorded for its own decision.
--
-- Not CONCURRENTLY: this is a multi-statement migration, and the runner refuses
-- CONCURRENTLY unless it is the only statement in the file. The table is small
-- and the brief write lock is acceptable.
-- =============================================================================

ALTER TABLE notifications
  ADD COLUMN offer_id UUID REFERENCES subscription_offers(id) ON DELETE CASCADE;

COMMENT ON COLUMN notifications.offer_id IS
  'The subscription offer this notification is about (grant-mode gifts). Part of idx_notifications_dedup, so two offers to the same reader from the same writer are two notifications rather than one.';

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
  );

CREATE INDEX idx_notifications_offer ON notifications (offer_id)
  WHERE offer_id IS NOT NULL;
