-- 142_payout_status_reversed.sql
--
-- F4 (Stripe transfer webhook model) — step 1 of 2: the new payout_status value.
--
-- A completed writer / publication payout that Stripe later REVERSES (a
-- platform-initiated transfer reversal claws the funds back to the platform)
-- leaves the paid state — it is terminally REVERSED. Adding the enum value is
-- isolated in its own migration because `ALTER TYPE … ADD VALUE` forces the
-- runner to apply the WHOLE file outside a transaction (shared/src/db/migrate.ts
-- — it cannot run inside BEGIN/COMMIT). Migration 143 carries the tribute_payouts
-- CHECK (which uses a text status column, not this enum) transactionally.
--
-- writer_payouts, publication_payouts and publication_payout_splits all use the
-- payout_status enum; tribute_payouts uses a text status + CHECK (migration 143).
--
-- Spec: docs/audits/allhaus-logic-economy-audit.md (F4).

ALTER TYPE public.payout_status ADD VALUE IF NOT EXISTS 'reversed';
