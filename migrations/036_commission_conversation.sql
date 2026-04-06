-- Link commissions to DM conversations they originated from
ALTER TABLE pledge_drives
  ADD COLUMN parent_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;

CREATE INDEX idx_drives_parent_conv ON pledge_drives(parent_conversation_id)
  WHERE parent_conversation_id IS NOT NULL;
