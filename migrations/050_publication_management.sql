-- Migration 050: Add homepage_layout column to publications
-- Supports the layout template picker (blog/magazine/minimal)

ALTER TABLE publications
  ADD COLUMN IF NOT EXISTS homepage_layout TEXT NOT NULL DEFAULT 'blog'
  CHECK (homepage_layout IN ('blog', 'magazine', 'minimal'));
