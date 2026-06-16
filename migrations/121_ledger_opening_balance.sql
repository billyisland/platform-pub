-- 121_ledger_opening_balance.sql
--
-- Architecture-audit 2026-06-15 item 3 (keystone) — Phase 3 prerequisite:
-- the one-time opening-balance backfill that lets the reader-balance read be
-- cut over to the ledger view.
--
-- THE PROBLEM. The ledger began EMPTY at Phase 1, so ledger_reader_balance
-- (= −SUM of a reader's tab-affecting entries) only reflects movements SINCE
-- the ledger went live. For any reader with pre-Phase-1 tab activity it
-- therefore disagrees with the live running total reading_tabs.balance_pence
-- by exactly that un-backfilled opening balance (reconcile-ledger.sql Part B
-- reports the gap). Phase 3 cannot point balance reads at the view until the
-- view equals the live column to the penny.
--
-- THE FIX (two steps, order matters):
--
--   1. Backfill one opening_balance entry per tab so −SUM(reader entries)
--      lands on the live balance. For each reading_tabs row let
--          L = current ledger balance = −SUM(existing real reader entries)
--          B = reading_tabs.balance_pence (the live running total)
--      We need −SUM(existing + opening) = B, i.e. opening_amount = L − B.
--      Computed directly over the real reader-tab triggers (NOT via the view,
--      which we are about to widen) so subscription_credit movements — the
--      Phase-1 gap this migration's companion code change just closed — are
--      already counted. ref = the reading_tabs row; counterparty NULL.
--      Only non-zero deltas are posted, so a reader already in agreement (and
--      every account on a fresh/empty boot) gets no row — this migration is
--      inert on a from-schema.sql DB.
--
--   2. Recreate ledger_reader_balance to also count subscription_credit (the
--      newly-mirrored tab credit-back) and opening_balance (this backfill), so
--      the view's −SUM spans EVERY reader-tab-affecting trigger. Done AFTER the
--      backfill so step 1's L is computed against the real movements only.
--
-- After this, reading_tabs.balance_pence stays as the locked operational
-- running total (settlement still reserves against it FOR UPDATE); the ledger
-- view becomes the source of truth for the reader-facing "what you owe" read.
-- The opening entries are append-only like all ledger rows — never edited.

-- ── step 1: opening-balance backfill ────────────────────────────────────────
-- L − B per reader, posted only where it is non-zero. The CTE sums the REAL
-- reader-tab triggers (everything except opening_balance itself).
WITH ledger_now AS (
  SELECT account_id, (-SUM(amount_pence))::bigint AS bal
  FROM ledger_entries
  WHERE trigger_type IN (
    'read_accrual', 'vote_charge', 'pledge_fulfil',
    'tab_settlement', 'subscription_credit'
  )
  GROUP BY account_id
)
INSERT INTO ledger_entries (
  account_id, counterparty_id, amount_pence, currency,
  trigger_type, ref_table, ref_id
)
SELECT rt.reader_id,
       NULL,
       (COALESCE(ln.bal, 0) - rt.balance_pence)::bigint,   -- L − B
       'GBP',
       'opening_balance',
       'reading_tabs',
       rt.id
FROM reading_tabs rt
LEFT JOIN ledger_now ln ON ln.account_id = rt.reader_id
WHERE (COALESCE(ln.bal, 0) - rt.balance_pence) <> 0;

-- ── step 2: widen the reader-balance view ───────────────────────────────────
-- Columns are unchanged (account_id, balance_pence), so CREATE OR REPLACE is
-- safe. Now spans all six reader-tab-affecting triggers.
CREATE OR REPLACE VIEW ledger_reader_balance AS
SELECT account_id,
       (-SUM(amount_pence))::bigint AS balance_pence
FROM ledger_entries
WHERE trigger_type IN (
  'read_accrual', 'vote_charge', 'pledge_fulfil',
  'tab_settlement', 'subscription_credit', 'opening_balance'
)
GROUP BY account_id;
