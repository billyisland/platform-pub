-- 143_tribute_payout_reversed_status.sql
--
-- F4 step 2 of 2: allow 'reversed' in the tribute_payouts.status text CHECK.
-- tribute_payouts uses a text status column + CHECK, not the payout_status enum
-- that migration 142 extended — so its allowed set is widened here (in a normal
-- transactional migration) to match the transfer.reversed handling added for the
-- writer / publication payouts.
--
-- Spec: docs/audits/allhaus-logic-economy-audit.md (F4).

ALTER TABLE public.tribute_payouts
  DROP CONSTRAINT tribute_payouts_status_check;

ALTER TABLE public.tribute_payouts
  ADD CONSTRAINT tribute_payouts_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'initiated'::text, 'completed'::text, 'failed'::text, 'reversed'::text]));
