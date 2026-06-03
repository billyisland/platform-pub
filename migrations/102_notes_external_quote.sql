-- Migration 102: External quote-notes (quoting a Bluesky/Mastodon/etc. post as a
-- native note).
--
-- The existing quote-note columns (quoted_event_id / quoted_event_kind) are
-- nostr-event-shaped: a native quote points at a nostr event id and renders a
-- rich quoted-mini from the snapshotted quoted_title / quoted_excerpt /
-- quoted_author. An external post (atproto/activitypub/rss/email) has no nostr
-- event id, so it cannot be NIP-18 q-tagged. To let a native note quote one and
-- still render the same rich mini, we denormalise three more columns (mirroring
-- how native quotes already snapshot title/excerpt/author):
--
--   • quoted_post_id — the quoted THING's deterministic post_id (§2.3). Lets the
--     /thread + feed projectors resolve `quotes_post_id` for an external quote the
--     same way quoted_event_id resolves it for a native one (dedup + future
--     re-root onto the quoted post).
--   • quoted_url      — the quoted post's public permalink (e.g. the bsky.app URL),
--     so the mini is clickable out to the origin.
--   • quoted_source   — the origin label (e.g. "BLUESKY") shown on the mini byline.
--
-- For a native quote these stay NULL (quoted_event_id carries the reference); for
-- an external quote quoted_event_id/quoted_event_kind stay NULL and these carry it.
-- Schema-only; the gateway insert + projectors read/write these in TS.

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS quoted_post_id text,
  ADD COLUMN IF NOT EXISTS quoted_url     text,
  ADD COLUMN IF NOT EXISTS quoted_source  text;
