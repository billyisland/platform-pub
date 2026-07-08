-- 149: pledge_drives.draft_id → ON DELETE SET NULL
--
-- The FK previously had no ON DELETE action, so deleting a draft that a
-- pledge drive referenced threw a constraint violation. Two manifestations:
--   * the scheduler's post-publish DELETE of a drive-backed scheduled draft
--     failed, the catch reset scheduled_at, and the draft republished every
--     60s forever;
--   * DELETE /drafts/:id 500'd for the writer.
-- The drive's link to the draft is only needed until publication (the
-- fulfilment trigger matches on draft_id and stamps article_id, and is now
-- awaited before any draft delete) — after that the draft row is disposable.

ALTER TABLE pledge_drives
  DROP CONSTRAINT pledge_drives_draft_id_fkey;

ALTER TABLE pledge_drives
  ADD CONSTRAINT pledge_drives_draft_id_fkey
    FOREIGN KEY (draft_id) REFERENCES article_drafts(id) ON DELETE SET NULL;
