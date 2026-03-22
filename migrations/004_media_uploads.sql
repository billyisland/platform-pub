-- =============================================================================
-- Migration 004: Media uploads tracking
-- Tracks Blossom uploads for moderation, quotas, and deduplication
-- =============================================================================

CREATE TABLE IF NOT EXISTS media_uploads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  blossom_url   TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INT NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_uploads_uploader ON media_uploads(uploader_id);
CREATE INDEX IF NOT EXISTS idx_media_uploads_sha256 ON media_uploads(sha256);
