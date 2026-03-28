-- =============================================================================
-- Migration 014: Prevent duplicate notifications
--
-- Removes existing duplicates (keeps the earliest), then adds a unique index
-- on (recipient, actor, type, target) so the same notification cannot be
-- inserted twice. Uses COALESCE to handle NULL FKs.
-- =============================================================================

-- Remove duplicates, keeping the oldest row per unique combination
DELETE FROM notifications n
USING notifications n2
WHERE n.recipient_id = n2.recipient_id
  AND n.actor_id IS NOT DISTINCT FROM n2.actor_id
  AND n.type = n2.type
  AND n.article_id IS NOT DISTINCT FROM n2.article_id
  AND n.note_id IS NOT DISTINCT FROM n2.note_id
  AND n.comment_id IS NOT DISTINCT FROM n2.comment_id
  AND n.created_at > n2.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications (
    recipient_id,
    actor_id,
    type,
    COALESCE(article_id, '00000000-0000-0000-0000-000000000000'),
    COALESCE(note_id, '00000000-0000-0000-0000-000000000000'),
    COALESCE(comment_id, '00000000-0000-0000-0000-000000000000')
  );
