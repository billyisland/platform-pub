-- Add conversation_id and drive_id to notifications for frontend routing
ALTER TABLE notifications ADD COLUMN conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN drive_id UUID REFERENCES pledge_drives(id) ON DELETE SET NULL;
