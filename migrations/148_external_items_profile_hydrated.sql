-- EXTERNAL-AUTHOR-HISTORY-ADR §3.3 — mark profile-hydrated timeline rows.
--
-- Profile-view timeline hydration persists an unfollowed author's recent posts
-- as is_context_only = TRUE (feed-excluded, context-GC'd) AND
-- is_profile_hydrated = TRUE, so GET /author/:id/posts can include them via
--   (ei.is_context_only IS NOT TRUE OR ei.is_profile_hydrated IS TRUE)
-- while feeds keep filtering on is_context_only alone. Real ingest promotion
-- (§4.2) clears both flags. No index: /posts is driven by the feed_items author
-- index; this flag is a post-join residual filter.
ALTER TABLE external_items
  ADD COLUMN is_profile_hydrated boolean NOT NULL DEFAULT FALSE;
