-- =============================================================================
-- 138_payout_predicate_indexes.sql
--
-- The daily payout cycle's workhorse predicate is
--   read_events  WHERE state = 'platform_settled' AND writer_payout_id IS NULL
--   vote_charges WHERE state = 'platform_settled' AND writer_payout_id IS NULL
-- (both usually further filtered by writer_id / recipient_id — payout.ts:498,501,
-- 507, and the publication-eligibility scan at :903). Until now these leaned on
-- the bare, low-cardinality idx_read_events_state / idx_vote_charges_state, whose
-- selectivity decays as terminal-state rows (writer_paid, charged_back) pile up
-- forever on these append-only tables.
--
-- These partial indexes mirror the tribute pattern (idx_tribute_accruals_
-- released_unclaimed / _swept_unclaimed): they cover ONLY the small live
-- settled-unpaid frontier, so they stay tiny regardless of history. The KEY is
-- the actual seek column (writer_id / recipient_id) — NOT writer_payout_id, which
-- is IS NULL across the whole partial set and so carries no selectivity.
--
-- NOTE: the bare idx_read_events_state / idx_vote_charges_state are deliberately
-- LEFT IN PLACE. State-only scans still exist (revenue dashboards, the reader
-- statement, settlement.ts) and no EXPLAIN evidence yet shows the bare indexes
-- are unused; dropping them is a separate, measured follow-up.
--
-- RUNBOOK (prod): these are plain CREATE INDEX (brief ACCESS EXCLUSIVE lock),
-- matching migration 128's precedent and fine at current table size. If the
-- tables have grown large by deploy time, build the two indexes manually as
-- non-locking concurrent builds first (the migrate runner detects that form and
-- runs it outside a txn), after which this migration is a no-op via IF NOT EXISTS.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_read_events_settled_unpaid
  ON public.read_events (writer_id)
  WHERE state = 'platform_settled' AND writer_payout_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_vote_charges_settled_unpaid
  ON public.vote_charges (recipient_id)
  WHERE state = 'platform_settled' AND writer_payout_id IS NULL;
