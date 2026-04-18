-- Migration 068: Article size tiers (lead / standard / brief)
--
-- Adds size_tier to articles for the redesign's three-tier card rendering.
-- Default is derived from word_count via a BEFORE INSERT trigger so that
-- editorial overrides (future UI) survive re-publishes; app code never sets
-- size_tier explicitly. See ALLHAUS-REDESIGN-SPEC.md §4a.

ALTER TABLE articles
  ADD COLUMN size_tier TEXT
  CHECK (size_tier IS NULL OR size_tier IN ('lead', 'standard', 'brief'));

-- Backfill from existing word_count
UPDATE articles SET size_tier = CASE
  WHEN word_count IS NULL           THEN 'standard'
  WHEN word_count >= 3000           THEN 'lead'
  WHEN word_count <  1000           THEN 'brief'
  ELSE 'standard'
END;

CREATE FUNCTION articles_derive_size_tier() RETURNS trigger AS $$
BEGIN
  IF NEW.size_tier IS NULL THEN
    NEW.size_tier := CASE
      WHEN NEW.word_count IS NULL OR NEW.word_count < 1000 THEN 'brief'
      WHEN NEW.word_count >= 3000                          THEN 'lead'
      ELSE 'standard'
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER articles_size_tier_default
BEFORE INSERT ON articles
FOR EACH ROW EXECUTE FUNCTION articles_derive_size_tier();
