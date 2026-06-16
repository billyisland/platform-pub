-- 120_ledger_views.sql
--
-- Architecture-audit 2026-06-15 item 3 (keystone) — Phase 2: read-model views.
--
-- Phase 0 added the append-only ledger_entries table; Phase 1 dual-wrote every
-- money MOVEMENT into it (accrual / settlement / payout / vote / pledge). This
-- migration builds the SUM() read-models the plan names, so "how does writer X
-- make a living here?" and "what does reader Y owe?" are single queries against
-- one spine instead of a hand-union of eight money surfaces.
--
-- These are plain (non-materialised) VIEWs: ledger_entries is append-only and
-- indexed on (account_id, created_at) / (ref_table, ref_id) / (trigger_type),
-- so the aggregates are cheap and always current. Phase 3 cuts the live balance
-- reads over to these; until then they are inert read-models (nothing depends
-- on them yet), so this migration is non-breaking.
--
-- SIGN CONVENTION (see shared/src/lib/ledger.ts — the authority):
--   amount_pence is signed from the ACCOUNT-HOLDER's perspective: (+) credit,
--   (−) debit. Reader-tab triggers (read_accrual / vote_charge / pledge_fulfil)
--   are debits; tab_settlement is the credit that pays the tab down. So a
--   reader's tab DEBT is −SUM over those four triggers. Payout triggers
--   (writer_payout / publication_split) are credits (money received).
--
-- FORWARD-ONLY CAVEAT (important for Phase 3): the ledger began EMPTY at Phase 1
-- — historic reading_tabs balances and past payouts were never backfilled. So
-- reader_balance equals reading_tabs.balance_pence only for accounts with no
-- pre-Phase-1 activity. Reconciling the two to the penny across ALL accounts
-- (and trusting the views as the source of balances) requires a one-time
-- opening-balance backfill — that backfill is the Phase 3 cutover prerequisite,
-- not part of this migration. scripts/reconcile-ledger.sql reports the gap.

-- ── reader_balance ──────────────────────────────────────────────────────────
-- A reader's outstanding tab DEBT, in pence. The tab grows as the reader reads
-- (debits) and is paid down by Stripe settlement (credit), so the debt is the
-- NEGATED sum of the reader-tab-affecting triggers. Reconciles (forward-only)
-- against reading_tabs.balance_pence keyed by reader_id == account_id.
CREATE VIEW ledger_reader_balance AS
SELECT account_id,
       (-SUM(amount_pence))::bigint AS balance_pence
FROM ledger_entries
WHERE trigger_type IN ('read_accrual', 'vote_charge', 'pledge_fulfil', 'tab_settlement')
GROUP BY account_id;

-- ── writer_earnings ─────────────────────────────────────────────────────────
-- Money an account has RECEIVED at payout — direct writer payouts plus its
-- share of publication splits. Credits, so a plain SUM. Reconciles against the
-- historic writer_payouts / publication_payout_splits sums for status-flipped
-- (non-'pending') rows.
CREATE VIEW ledger_writer_earnings AS
SELECT account_id,
       SUM(amount_pence)::bigint AS earned_pence
FROM ledger_entries
WHERE trigger_type IN ('writer_payout', 'publication_split')
GROUP BY account_id;

-- ── publication_distribution ────────────────────────────────────────────────
-- Total distributed to members per publication. The ledger row records the
-- member's account, not the publication, so resolve the publication by joining
-- the originating split row back through to its payout. Reconciles against
-- SUM(publication_payout_splits.amount_pence) per publication (flipped rows).
CREATE VIEW ledger_publication_distribution AS
SELECT pp.publication_id,
       SUM(le.amount_pence)::bigint AS distributed_pence
FROM ledger_entries le
JOIN publication_payout_splits ps ON ps.id = le.ref_id
JOIN publication_payouts pp ON pp.id = ps.publication_payout_id
WHERE le.trigger_type = 'publication_split'
  AND le.ref_table = 'publication_payout_splits'
GROUP BY pp.publication_id;

-- ── platform_tax ────────────────────────────────────────────────────────────
-- Behaviour tax retained by the platform: a downvote charges the voter with NO
-- counterparty author (counterparty_id IS NULL = platform), distinguishing it
-- from an upvote (counterparty = the credited author). The voter's entry is a
-- debit (−), so the tax COLLECTED is the negated sum, keyed by the voter who
-- paid it. (Upvote vote_charges, having a non-NULL author counterparty, are
-- excluded — they are author revenue, not platform tax.)
CREATE VIEW ledger_platform_tax AS
SELECT account_id,
       (-SUM(amount_pence))::bigint AS tax_paid_pence
FROM ledger_entries
WHERE trigger_type = 'vote_charge'
  AND counterparty_id IS NULL
GROUP BY account_id;
