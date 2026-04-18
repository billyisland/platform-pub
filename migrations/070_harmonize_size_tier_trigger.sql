-- Migration 070: Harmonize articles_derive_size_tier with backfill semantics
--
-- Migration 068 backfilled NULL word_count → 'standard' but the trigger maps
-- it to 'brief'. New rows with NULL word_count would silently disagree with
-- the historical population. Match the backfill so the rule is single-sourced:
-- unknown length defaults to 'standard' (the safe middle), not 'brief'.

CREATE OR REPLACE FUNCTION articles_derive_size_tier() RETURNS trigger AS $$
BEGIN
  IF NEW.size_tier IS NULL THEN
    NEW.size_tier := CASE
      WHEN NEW.word_count IS NULL       THEN 'standard'
      WHEN NEW.word_count >= 3000       THEN 'lead'
      WHEN NEW.word_count <  1000       THEN 'brief'
      ELSE 'standard'
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
