-- DM likes: a user can "like" (heart) a direct message once
CREATE TABLE dm_likes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID        NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

CREATE INDEX idx_dm_likes_message ON dm_likes (message_id);

-- Clean up stale new_message notifications — DMs have their own unread tracking
UPDATE notifications SET read = true WHERE type = 'new_message' AND read = false;
