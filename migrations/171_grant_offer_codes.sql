-- =============================================================================
-- 171 — mint a code for every existing grant-mode subscription offer
--
-- Grant offers were created with `code = NULL`, and both the redeem lookup and
-- the /subscribe/:code page are code-keyed — so a grant had no URL and no way
-- to be redeemed (CONSOLIDATED-TODO §1.10). The route now mints a code for both
-- modes; this gives the historical rows one so they are reachable too, rather
-- than leaving a cohort of offers that are permanently dead while every new one
-- works.
--
-- The code is an ADDRESS, not the secret: a grant resolves only for the account
-- it names (checked in the lookup AND again at redemption), so minting one
-- grants nobody anything. gen_random_uuid() rather than random bytes because it
-- is built in — no pgcrypto dependency — and `subscription_offers.code` is
-- UNIQUE, which a UUID satisfies by construction.
--
-- Revoked offers are skipped: they are not redeemable regardless, and a URL for
-- one would be a link that always 404s.
-- =============================================================================

UPDATE subscription_offers
   SET code = replace(gen_random_uuid()::text, '-', '')
 WHERE mode = 'grant'
   AND code IS NULL
   AND revoked_at IS NULL;
