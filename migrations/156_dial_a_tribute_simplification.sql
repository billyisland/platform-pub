-- 156: Dial-A tribute simplification — retire the held/swept/returned machinery
--
-- UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md › Decision (2026-07-13); UPSTREAM-EDGES-
-- BUILD-PLAN.md › Dial-A rework; PAYMENTS-FIXES-AND-DILEMMAS §2.2 / §E.
--
-- Dial A = consent-gated, forward-only accrual: no tribute_accruals row exists
-- until the tribute is `live` (consented + onboarding), and a share is frozen
-- only on reads that settle AFTER that. So a share is NEVER held for a non-
-- consenting party — the `held`, `swept`, `returned` states and the chain
-- swept-return-to-parent plumbing (swept_return_payout_id / swept_return_kind)
-- exist ONLY to hold-then-return an unconsented share and are now dead. An
-- accrual is only ever `released → paid` (+ `voided`/reversed on chargeback).
--
-- The feature has never been enabled (TRIBUTES_ENABLED off in every env), so
-- tribute_accruals is empty; the remap below is a defensive no-op that keeps any
-- stray row valid before the CHECK narrows. (The append-only trigger permits a
-- state UPDATE — only amount/identity changes and DELETE/TRUNCATE are blocked.)

-- (1) Remap any stray non-Dial-A rows so the narrowed CHECK accepts them. A
--     `held` (unconsented) or `swept`/`returned` (returned-to-author) share is
--     money that under Dial A was never accrued — void it (it returns to the
--     author's ordinary payable, off-ledger, exactly as before).
UPDATE tribute_accruals SET state = 'voided'
  WHERE state IN ('held', 'swept', 'returned');

-- (2) Narrow the state CHECK to the Dial-A set.
ALTER TABLE tribute_accruals
  DROP CONSTRAINT tribute_accruals_state_check,
  ADD CONSTRAINT tribute_accruals_state_check
    CHECK (state IN ('released', 'paid', 'voided'));

-- (3) Drop the swept-return plumbing (the two CHECKs first, then the columns;
--     dropping the columns would cascade these anyway, but be explicit).
ALTER TABLE tribute_accruals
  DROP CONSTRAINT tribute_accruals_swept_return_consistency,
  DROP CONSTRAINT tribute_accruals_swept_return_kind_check;

-- (4) Drop the swept-unclaimed partial index (keyed on the column being dropped).
DROP INDEX IF EXISTS idx_tribute_accruals_swept_unclaimed;

ALTER TABLE tribute_accruals
  DROP COLUMN swept_return_payout_id,
  DROP COLUMN swept_return_kind;
