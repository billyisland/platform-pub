-- 112: per-feed appearance (feature-debt §3 "Per-feed colour schemes").
--
-- A feed's colour scheme is feed character, so it travels with the feed
-- rather than living in per-device localStorage (stores/workspace.ts holds
-- only the legacy light/dark brightness, which becomes the fallback for
-- feeds that have never picked a scheme). JSONB rather than a text column so
-- later appearance axes (density, orientation, sort_rank per
-- MOBILE-LAYOUT-ADR) can land without further DDL.
--
-- Shape today: {} or { "scheme": "<id>" } where <id> is one of the curated
-- scheme ids in web/src/components/workspace/tokens.ts (validated at the
-- gateway; unknown ids normalise to the light default client-side).

ALTER TABLE feeds
  ADD COLUMN appearance jsonb NOT NULL DEFAULT '{}'::jsonb;
