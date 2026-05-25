-- =============================================================================
-- 094: External Protocol Expansion — enum values
--
-- Extends external_protocol enum with farcaster, matrix, telegram, email.
-- Must run outside a transaction (ALTER TYPE ADD VALUE cannot be used inside
-- a transaction block). The CHECK constraint update follows in 095.
-- =============================================================================

ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'farcaster';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'matrix';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'telegram';
ALTER TYPE external_protocol ADD VALUE IF NOT EXISTS 'email';
