-- Default new source volume to step 5 (weight 4.0 = "show everything").
-- Subscribers want to see all content from sources they add; they can dial down.
-- Existing rows keep their stored weights.
ALTER TABLE feed_sources ALTER COLUMN weight SET DEFAULT 4.0;
