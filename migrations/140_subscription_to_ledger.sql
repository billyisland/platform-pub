-- =============================================================================
-- 140_subscription_to_ledger.sql  (audit F1, 2026-07-05)
--
-- Bring subscriptions inside the unified ledger and the payout base.
--
-- Before F1, a subscription "charge" decremented accounts.free_allowance_
-- remaining_pence — a column no settlement path ever collects — so subscription
-- revenue was never collected and the writer credit never paid out (finding 1,
-- a P0). F1 makes logSubscriptionCharge debit reading_tabs.balance_pence and post
-- two new ledger triggers:
--   • subscription_charge  (reader tab debit, −price) — a reader-tab entry, so
--     ledger_reader_balance must count it (keeps −SUM == balance).
--   • subscription_earning (writer earned, +net) — a writer earned-side entry
--     for WRITER subscriptions, folded into the per-read payout base and counted
--     by ledger_writer_earned.
--
-- The earning is claimed by exactly one writer payout via a new
-- subscription_events.writer_payout_id (mirroring read_events / vote_charges).
-- =============================================================================

-- Claim column: which writer payout paid this earning (NULL = unpaid). Only
-- 'subscription_earning' rows with a writer_id are ever claimed.
ALTER TABLE public.subscription_events
  ADD COLUMN IF NOT EXISTS writer_payout_id uuid REFERENCES public.writer_payouts(id);

-- Partial index over the small unpaid-earning frontier the payout cycle scans
-- (mirrors idx_read_events_settled_unpaid). KEY is the seek column writer_id.
CREATE INDEX IF NOT EXISTS idx_subscription_events_earning_unpaid
  ON public.subscription_events (writer_id)
  WHERE event_type = 'subscription_earning'
    AND writer_id IS NOT NULL
    AND publication_id IS NULL
    AND writer_payout_id IS NULL;

-- Reader-balance view: subscription_charge is a reader-tab movement, so it must
-- net against tab_settlement like read_accrual does (−SUM == balance_pence).
CREATE OR REPLACE VIEW public.ledger_reader_balance AS
 SELECT account_id,
    ((- sum(amount_pence)))::bigint AS balance_pence
   FROM public.ledger_entries
  WHERE (trigger_type = ANY (ARRAY['read_accrual'::text, 'vote_charge'::text, 'pledge_fulfil'::text, 'tab_settlement'::text, 'subscription_credit'::text, 'subscription_charge'::text, 'opening_balance'::text, 'dispute_stake'::text, 'dispute_stake_refund'::text, 'tab_settlement_reversal'::text]))
  GROUP BY account_id;

-- Writer-earned view: subscription_earning is earned income (like writer_accrual)
-- and is folded into the payout base, so the earned headline must reflect it.
CREATE OR REPLACE VIEW public.ledger_writer_earned AS
 SELECT account_id,
    (sum(amount_pence))::bigint AS earned_pence
   FROM public.ledger_entries
  WHERE (trigger_type = ANY (ARRAY['writer_accrual'::text, 'writer_accrual_reversal'::text, 'tribute_carve'::text, 'tribute_carve_reversal'::text, 'subscription_earning'::text]))
  GROUP BY account_id;
