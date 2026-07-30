-- 166: correct the allocated_draws sign convention COMMENT (docs-only, no DDL).
--
-- Migration 165's table comment stated the refund sign BACKWARDS: it said
-- refund draws are negative, while the implementation (recordRefundDraw's
-- GREATEST upsert, §3.5) correctly stores Stripe's cumulative amount_refunded
-- as a POSITIVE gross_pence — the budget is `allocated_pence − Σ(gross_pence)`
-- (lockFundingSources), so positive consumes and negative returns. A refund
-- consumes budget; only a transfer REVERSAL returns it (reverseChild inserts
-- −delta). A future implementer following the old comment would have stored
-- refunds negative and GROWN the drawing budget on refund — recreating the
-- exact over-draw the charge.refunded hook exists to close.
--
-- 165 is checksummed and applied, so the correction is this new migration.
-- Found by the 2026-07-30 commit review (finding 5).

COMMENT ON TABLE allocated_draws IS
  'Drawing budget against a charge''s Stripe allocation (migration 165; sign corrected in 166). The budget is allocated_pence - SUM(gross_pence), so a POSITIVE row consumes budget and a NEGATIVE row returns it. One row per claim: transfer (+, the child''s gross placed on the charge), refund (+, allocation consumed by a refund — cumulative amount_refunded, GREATEST-upserted because webhook delivery is unordered), reversal (-, funds returned to allocated state by a transfer reversal). NOT a ledger — it records no money movement and mirrors no ledger_entries row.';
