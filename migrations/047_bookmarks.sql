-- Bookmarks: readers save articles for later.
CREATE TABLE bookmarks (
  user_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id    UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

CREATE INDEX idx_bookmarks_user ON bookmarks(user_id, created_at DESC);
