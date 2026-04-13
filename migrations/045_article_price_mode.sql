-- Add article pricing mode: 'per_article' (flat) or 'per_1000_words' (scales with word count)
ALTER TABLE publications
  ADD COLUMN article_price_mode TEXT NOT NULL DEFAULT 'per_article'
  CHECK (article_price_mode IN ('per_article', 'per_1000_words'));
