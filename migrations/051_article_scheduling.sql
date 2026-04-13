ALTER TABLE article_drafts ADD COLUMN scheduled_at TIMESTAMPTZ;

CREATE INDEX idx_drafts_scheduled
  ON article_drafts (scheduled_at)
  WHERE scheduled_at IS NOT NULL;
