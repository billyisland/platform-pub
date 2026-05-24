-- =============================================================================
-- 092: Interaction foundation (Phase 4A)
--
-- 1. Extend outbound_posts.action_type to include 'like' and 'poll_vote'
-- 2. Add external_parent_id to notes for reply dual-write (Phase 4C prereq)
-- =============================================================================

ALTER TABLE outbound_posts DROP CONSTRAINT outbound_posts_action_type_check;
ALTER TABLE outbound_posts ADD CONSTRAINT outbound_posts_action_type_check
  CHECK (action_type = ANY (ARRAY['reply', 'quote', 'repost', 'original', 'like', 'poll_vote']));

ALTER TABLE notes ADD COLUMN external_parent_id UUID REFERENCES external_items(id) ON DELETE SET NULL;
