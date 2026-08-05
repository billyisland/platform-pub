-- =============================================================================
-- 174 — drive_id joins the dedup index, and the drive notifications bind it
--
-- Migration 020 added `notifications.drive_id` with the stated purpose "for
-- frontend routing". Nothing has ever written it. The column is real, the FK is
-- real (ON DELETE SET NULL — a deleted drive leaves its notification standing,
-- unlike an offer's CASCADE), `notifications.ts` selects it and the web's
-- `Notification` interface declares `driveId?: string` — end-to-end plumbing
-- with no source. Found 2026-08-05 while fixing the two `ON CONFLICT` defects
-- below; it is migration 172's bug one table over.
--
-- WHY IT MATTERS HERE, rather than being a tidy-up. `idx_notifications_dedup`
-- keyed on (recipient, actor, type, article, note, comment, offer), and the
-- three drive notifications set NONE of those — so to that index, two DIFFERENT
-- drives between the same two people are the same notification. That made the
-- missing ON CONFLICT unfixable in isolation: adding `DO NOTHING` alone would
-- have converted a crash into a silent drop, which on `drive_funded` means a
-- creator is never told their second drive was funded. Adding the column makes
-- two drives two rows, so there is no collision to swallow.
--
-- THE TWO DEFECTS THIS UNBLOCKS (gateway/src/routes/drives.ts). `drive_funded`
-- and `commission_request` were the only two `INSERT INTO notifications` in the
-- codebase with no `ON CONFLICT` clause at all, so a dedup collision raised
-- 23505 rather than doing nothing. `drive_funded`'s sits INSIDE the pledge
-- `withTransaction`: the same pledger funding a second drive by the same
-- creator aborted the pledge itself — the money never moved and the pledger got
-- a 500, on a money path, from a notification. Both are behind
-- `PLEDGES_ENABLED` (the `/drives` plugin 403s wholesale while parked), so this
-- is a fix ahead of resurrection rather than a live incident.
--
-- Keeps 173's partial clause (`WHERE read = false`) and 173's bare `actor_id`
-- — NULLs must stay distinct so `pledge_fulfilled`, which names no actor, never
-- dedups. Rebuilt rather than amended because an index cannot be ALTERed.
--
-- Safe on existing data: adding a column to a unique index only ever
-- DISTINGUISHES rows that previously collided, so a table satisfying the old
-- index satisfies this one. No de-duplication pass.
--
-- Not CONCURRENTLY: multi-statement, which the runner refuses for CONCURRENTLY.
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
    COALESCE(offer_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(drive_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE read = false;

COMMENT ON INDEX idx_notifications_dedup IS
  'At most one UNREAD notification per (recipient, actor, type, targets). Reading a notification frees its slot so the next occurrence of the same event notifies again — migration 019''s intent, in force from 173. Every INSERT INTO notifications is a bare ON CONFLICT DO NOTHING, so this index alone decides what collapses. actor_id is deliberately NOT COALESCEd: actor-less types (pledge_fulfilled) must never dedup against each other.';

COMMENT ON COLUMN notifications.drive_id IS
  'The pledge drive this notification is about (commission_request, drive_funded, pledge_fulfilled). Part of idx_notifications_dedup, so two drives between the same two people are two notifications rather than one. ON DELETE SET NULL, not CASCADE — the notification still reads sensibly without the drive.';

CREATE INDEX idx_notifications_drive ON notifications (drive_id)
  WHERE drive_id IS NOT NULL;
