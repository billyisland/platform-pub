-- 136_ledger_writer_earned.sql
--
-- Architecture-audit 2026-06-15 item 3 (keystone) — FINAL phase: the writer-side
-- accrual cutover. Companion code change teaches the ledger to model writer-side
-- EARNING (writer_accrual at settlement, tribute_carve when a root carve is paid,
-- and the two reversals on chargeback). This migration backfills history and adds
-- the read-model view the dashboard's earned-total now reads.
-- Spec: docs/audits/WRITER-SIDE-LEDGER-CUTOVER.md.
--
-- NOT idempotent: re-running outside the _migrations run-once guard double-counts
-- the backfilled entries. Do not replay. Inert on a fresh/from-schema.sql DB
-- (no reads, no accruals ⇒ no rows) — the 121 precedent.
--
-- THE MODEL (why these two backfills reproduce ledger_writer_earned exactly):
--   ledger_writer_earned(X) = read_net(X) − paid_root_carve(X)
-- The held/released carve deliberately never enters the ledger (build-plan guard
-- #7 — it is still the author's money); only a carve PAID to the inspirer debits
-- the author. So history is two strands:
--   (1) writer_accrual  +read_net  per settled/paid read   (the author's earning)
--   (2) tribute_carve   −root_gross per PAID root accrual   (the redirect executed)
-- Charged-back reads carry no forward accrual, so they are excluded from (1);
-- held/released/swept/returned/voided carve never debited the author, so only
-- 'paid' root accruals appear in (2). Dark today ⇒ (2) is empty.

-- ── step 1: writer_accrual backfill ─────────────────────────────────────────
-- One entry per read EARNED (platform_settled | writer_paid; charged_back NOT
-- earned). Net = per-read-then-floor against the live platform fee (matching
-- getWriterEarnings + the forward settlement.ts entry). cp = the reader, ref =
-- the read. Only non-zero nets posted.
INSERT INTO ledger_entries (
  account_id, counterparty_id, amount_pence, currency,
  trigger_type, ref_table, ref_id
)
SELECT r.writer_id,
       r.reader_id,
       (r.amount_pence - FLOOR(r.amount_pence
         * COALESCE((SELECT value::int FROM platform_config WHERE key = 'platform_fee_bps'), 800)
         / 10000))::bigint,
       'GBP',
       'writer_accrual',
       'read_events',
       r.id
FROM read_events r
WHERE r.state IN ('platform_settled', 'writer_paid')
  AND (r.amount_pence - FLOOR(r.amount_pence
        * COALESCE((SELECT value::int FROM platform_config WHERE key = 'platform_fee_bps'), 800)
        / 10000)) <> 0;

-- ── step 2: tribute_carve backfill ──────────────────────────────────────────
-- One entry per tribute_payout that paid ROOT accruals: the author's redirect
-- executed. −Σ(root accrual gross) for that payout, account = article author,
-- cp = root inspirer, ref = the payout (matching the forward completeTributePayout
-- entry, which aggregates the payout's flipped root accruals). Empty while dark.
INSERT INTO ledger_entries (
  account_id, counterparty_id, amount_pence, currency,
  trigger_type, ref_table, ref_id
)
SELECT t.author_account_id,
       t.resolved_account_id,
       (-SUM(ta.amount_pence))::bigint,
       'GBP',
       'tribute_carve',
       'tribute_payouts',
       ta.tribute_payout_id
FROM tribute_accruals ta
JOIN tributes t ON t.id = ta.tribute_id
WHERE ta.state = 'paid'
  AND t.parent_tribute_id IS NULL
  AND ta.tribute_payout_id IS NOT NULL
GROUP BY ta.tribute_payout_id, t.author_account_id, t.resolved_account_id;

-- ── step 3: the earned-incl-pending read-model view ─────────────────────────
-- The earned-side counterpart to ledger_writer_earnings (paid-out). A DISJOINT
-- trigger set: it never sums the payout triggers, and the payout view never sums
-- these. earned_pence(X) = read_net − paid_root_carve.
CREATE VIEW ledger_writer_earned AS
SELECT account_id,
       SUM(amount_pence)::bigint AS earned_pence
FROM ledger_entries
WHERE trigger_type IN (
  'writer_accrual', 'writer_accrual_reversal',
  'tribute_carve', 'tribute_carve_reversal'
)
GROUP BY account_id;
