-- 097: Add is_reply to feed_items for reply signalling + filtering
--
-- Denormalised from source tables so the feed query can filter/display
-- without joining notes/external_items on every row.

ALTER TABLE feed_items ADD COLUMN is_reply BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: external items with a source_reply_uri are replies
UPDATE feed_items fi SET is_reply = TRUE
FROM external_items ei
WHERE fi.external_item_id = ei.id
  AND ei.source_reply_uri IS NOT NULL;

-- Backfill: native notes with reply_to_event_id are replies
UPDATE feed_items fi SET is_reply = TRUE
FROM notes n
WHERE fi.note_id = n.id
  AND n.reply_to_event_id IS NOT NULL;
