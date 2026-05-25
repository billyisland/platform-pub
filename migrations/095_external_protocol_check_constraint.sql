-- =============================================================================
-- 095: External Protocol Check Constraint Update
--
-- Updates protocol_tier_consistency CHECK to cover the new protocol values
-- added in 094. Separated because ALTER TYPE ADD VALUE must commit before
-- the new values can be referenced.
-- =============================================================================

ALTER TABLE external_items DROP CONSTRAINT protocol_tier_consistency;
ALTER TABLE external_items ADD CONSTRAINT protocol_tier_consistency CHECK (
  (protocol = 'nostr_external' AND tier = 'tier2')
  OR (protocol IN ('atproto', 'activitypub', 'farcaster') AND tier = 'tier3')
  OR (protocol IN ('rss', 'telegram', 'matrix', 'email') AND tier = 'tier4')
);
