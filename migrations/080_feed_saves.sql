-- =============================================================================
-- 080: feed_saves — workspace experiment slice 20 (per-feed save persistence)
--
-- Per WORKSPACE-EXPERIMENT-ADR §3 + the slice-11 build log: the workspace
-- replaces the global BookmarkButton with per-feed Save. A vessel is the
-- attentional surface, so its saved-items list is per-feed, not global. This
-- table records "this feed has saved this feed_item." Pulling the saved view
-- on a vessel renders these rows in save-time DESC order.
--
-- Why per-feed and not per-user. Saves are tied to the vessel that minted
-- them — if you save an article in your tech feed and a different one in
-- your friends feed, the two lists stay separate. A user can save the same
-- item in two feeds (two rows). The legacy `bookmarks` table (articles only,
-- per-user, global) survives until the deprecated reading-mode chassis
-- retires on merge to master.
--
-- Why not denorm saved_by. The feed has owner_id; the route checks the
-- caller is the owner before any write or read; CASCADE on feeds handles
-- user-deletion. A saved_by column would be redundant in the current
-- single-owner model. If shared/group feeds ever land, we add the column
-- then — adding a NOT NULL UUID with a sensible default is straightforward.
-- =============================================================================

CREATE TABLE feed_saves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  feed_item_id UUID NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One save per feed-per-item. Re-saving is idempotent.
  CONSTRAINT feed_saves_unique UNIQUE (feed_id, feed_item_id)
);

-- Listing index: the saved view orders by save-time DESC; this index
-- supports both the cursor scan and the `ids` lookup. Per-feed scoping is
-- already in the unique key.
CREATE INDEX feed_saves_feed_idx ON feed_saves (feed_id, created_at DESC, id DESC);
