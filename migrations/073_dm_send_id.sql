-- 073_dm_send_id.sql
--
-- Add `send_id` to direct_messages so one logical group-DM send can be
-- identified across its N per-recipient rows. Without this, a sender in a
-- 3-person group sees their own message 3× in their own inbox view
-- (`loadConversationMessages` WHERE `sender_id = $2 OR recipient_id = $2`
-- matches all N rows when $2 is the sender).
--
-- Fix: read path does DISTINCT ON (send_id), preferring the row addressed
-- to the viewer so the viewer can decrypt NIP-44 ciphertext with their own
-- key material.
--
-- Existing rows each get their own fresh UUID (the default). No collapsing —
-- we cannot reconstruct historical "sends" post-hoc, so old duplicates stay
-- as they were. Only new sends use one shared send_id across all rows.

ALTER TABLE direct_messages
  ADD COLUMN send_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX idx_dm_send_id ON direct_messages (send_id);
