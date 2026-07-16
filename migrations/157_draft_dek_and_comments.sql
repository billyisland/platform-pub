-- 157: carry dek (standfirst) and comments_enabled on article_drafts
--
-- Deep-audit M20/M19 (2026-07-16). article_drafts had no column for the dek
-- (standfirst/summary) or the "allow replies" toggle, so:
--   • The whole draft pipeline silently dropped the dek (the gateway drafts
--     schema had no field, Zod stripped it, GET returned none) — reopening a
--     draft lost the standfirst, and a SCHEDULED article published with no
--     summary and no NIP-23 `summary` tag.
--   • A scheduled article always published comments-on, ignoring the writer's
--     toggle (the publish-now path was fixed separately; the scheduler reads the
--     draft, which had nowhere to carry the flag).
-- Both are nullable so existing drafts are unaffected and the draft upserts'
-- COALESCE(EXCLUDED.x, existing) "keep on conflict" pattern works uniformly
-- (NULL = "not provided this save"). NULL comments_enabled reads as true (the
-- default) at publish time.

ALTER TABLE article_drafts
  ADD COLUMN IF NOT EXISTS dek text,
  ADD COLUMN IF NOT EXISTS comments_enabled boolean;
