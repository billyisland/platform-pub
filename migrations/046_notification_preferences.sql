-- Notification preferences: per-user opt-out for each notification category.
-- Absence of a row means "enabled" (default on).
CREATE TABLE notification_preferences (
  user_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);
