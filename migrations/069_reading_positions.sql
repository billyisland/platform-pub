-- Migration 069: Reading-position resumption
--
-- Per-user, per-article scroll position so that returning to an article
-- mounts at the position the reader last left it. Replaces the bookmark
-- gesture with an ambient "remember my place" mechanism.
--
-- See docs/adr/ALLHAUS-REDESIGN-SPEC.md §4 "Reading history and resumption".

CREATE TABLE reading_positions (
  user_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id    UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  scroll_ratio  REAL NOT NULL CHECK (scroll_ratio >= 0 AND scroll_ratio <= 1),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

CREATE INDEX idx_reading_positions_user ON reading_positions(user_id, updated_at DESC);

-- Per-user preference: when true, /article/[dTag] always opens at the top
-- regardless of any stored scroll position. Default false (resume by default).
ALTER TABLE accounts
  ADD COLUMN always_open_articles_at_top BOOLEAN NOT NULL DEFAULT FALSE;
