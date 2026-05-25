-- =============================================================================
-- 094: External Protocol Expansion
--
-- Extends external_protocol enum with farcaster, matrix, telegram, email.
-- Updates the protocol_tier_consistency CHECK to cover all protocols.
-- =============================================================================

-- New protocol values
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'farcaster';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'matrix';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'telegram';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'email';

-- Replace the CHECK with one that covers all protocols.
-- (rss stays tier4; telegram and email are unverified → tier4;
--  farcaster has crypto authorship → tier3; matrix → tier4)
ALTER TABLE external_items DROP CONSTRAINT protocol_tier_consistency;
ALTER TABLE external_items ADD CONSTRAINT protocol_tier_consistency CHECK (
  (protocol = 'nostr_external' AND tier = 'tier2')
  OR (protocol IN ('atproto', 'activitypub', 'farcaster') AND tier = 'tier3')
  OR (protocol IN ('rss', 'telegram', 'matrix', 'email') AND tier = 'tier4')
);
