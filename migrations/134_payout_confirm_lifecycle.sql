-- 134: tribute payout confirmation lifecycle.
--
-- transfer.paid / transfer.failed webhooks for TRIBUTE and PUBLICATION transfers
-- were previously routed only to the writer-payout handlers (payout.ts::
-- confirmPayout / handleFailedPayout), which UPDATE writer_payouts only. A
-- tribute or publication-split transfer therefore matched no row, hit the
-- log-and-return no-op, and:
--   • a landed tribute transfer never advanced past 'initiated' (no 'completed'
--     state existed on tribute_payouts at all), and
--   • a FAILED tribute transfer was never rolled back — the inspirer's accruals
--     stayed 'paid' and the +tribute_payout ledger entry stood for money that
--     never landed, with no re-pay.
--
-- This migration gives tribute_payouts the same confirmation lifecycle as
-- writer_payouts / publication_payouts: a 'completed' status and a completed_at
-- stamp. publication_payouts / publication_payout_splits already use the
-- payout_status enum (which carries 'completed'), so only tribute_payouts needs
-- the column + widened CHECK.

ALTER TABLE tribute_payouts
  ADD COLUMN completed_at timestamp with time zone;

ALTER TABLE tribute_payouts
  DROP CONSTRAINT tribute_payouts_status_check;

ALTER TABLE tribute_payouts
  ADD CONSTRAINT tribute_payouts_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'initiated'::text, 'completed'::text, 'failed'::text]));
