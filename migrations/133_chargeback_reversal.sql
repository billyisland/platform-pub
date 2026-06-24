-- 133_chargeback_reversal.sql
--
-- F3 (reader chargeback/refund reversal) — step 2 of 2 (transactional).
--
-- Builds the schema the platform-wide reversal path needs, onto which the
-- tribute-subtree void composes (the ADR's "platform-wide first, then the
-- subtree composes" shape). Triggered by charge.dispute.closed (lost) and
-- charge.refunded; see payment-service settlement.reverseSettlement +
-- webhook.ts. read_state's new 'charged_back' value landed in migration 132.
--
-- Companion: docs/adr/UPSTREAM-EDGES-AUDIT-FIXES.md (F3),
-- docs/adr/UPSTREAM-EDGES-ADR.md (Edge cases), docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md.

-- ---------------------------------------------------------------------------
-- (1) tribute_accruals gains 'voided' — the reversal disposition for an accrual
-- on a charged-back read. held/released/swept (never paid out) are voided in
-- place with NO ledger entry; a 'paid'/'returned' accrual is also voided but
-- pairs with a reversing ledger entry (the money already left). The migration-130
-- append-only guard permits this (it blocks amount/tribute/read changes, allows
-- state transitions).
-- ---------------------------------------------------------------------------
ALTER TABLE public.tribute_accruals DROP CONSTRAINT tribute_accruals_state_check;
ALTER TABLE public.tribute_accruals ADD CONSTRAINT tribute_accruals_state_check
  CHECK ((state = ANY (ARRAY['held'::text, 'released'::text, 'paid'::text, 'swept'::text, 'returned'::text, 'voided'::text])));

-- ---------------------------------------------------------------------------
-- (2) tab_settlements gains the reversal claim. reversed_at is the idempotency
-- guard the handler claims under (WHERE reversed_at IS NULL) so a duplicate
-- webhook — or a refund followed by a dispute-lost on the same charge — reverses
-- exactly once. status stays 'completed' (the charge DID complete; it is now also
-- reversed); reversed_at is the marker every reversal-aware query keys off.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tab_settlements
  ADD COLUMN reversed_at timestamp with time zone,
  ADD COLUMN reversal_reason text;

-- ---------------------------------------------------------------------------
-- (3) vote_charges gains an explicit settlement link so the reversal can scope a
-- disputed charge's upvote charges exactly (reads already carry tab_settlement_id;
-- votes were only ever advanced by tab_id + a created_at<=settled_at window).
-- Going forward confirmSettlement stamps it; this backfills history.
--
-- Backfill heuristic — the settlement that advanced a settled vote is the
-- EARLIEST completed settlement on its tab whose settled_at >= the vote's
-- created_at (confirmSettlement advances every 'accrued' vote with
-- created_at <= settled_at, so the first completed settlement after creation is
-- the one that caught it). IMPERFECT for a vote that stayed 'provisional' across
-- an earlier settlement and only converted later — it would mis-attribute to that
-- earlier settlement. This is rare, and the reader side of a reversal is exact
-- regardless (it restores the full charge amount); only the writer-side rollback
-- of that one vote could attach to the wrong (same-reader) settlement. Votes
-- still provisional/accrued (never settled) keep a NULL link, correctly.
-- ---------------------------------------------------------------------------
ALTER TABLE public.vote_charges
  ADD COLUMN tab_settlement_id uuid REFERENCES public.tab_settlements(id);

CREATE INDEX idx_vote_charges_tab_settlement ON public.vote_charges (tab_settlement_id);

UPDATE public.vote_charges vc
   SET tab_settlement_id = (
     SELECT s.id FROM public.tab_settlements s
      WHERE s.tab_id = vc.tab_id
        AND s.status = 'completed'
        AND s.settled_at >= vc.created_at
      ORDER BY s.settled_at ASC
      LIMIT 1
   )
 WHERE vc.state IN ('platform_settled', 'writer_paid')
   AND vc.tab_settlement_id IS NULL;

-- ---------------------------------------------------------------------------
-- (4) ledger_reader_balance must count tab_settlement_reversal — it moves the
-- disputant/reader's tab (the settlement credit is reversed, the debt returns),
-- so omitting it breaks the keystone invariant −SUM(ledger) == balance_pence
-- (reconcile B1). MANDATORY, same reasoning as the dispute_stake widening.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.ledger_reader_balance AS
 SELECT account_id,
    ((- sum(amount_pence)))::bigint AS balance_pence
   FROM public.ledger_entries
  WHERE (trigger_type = ANY (ARRAY['read_accrual'::text, 'vote_charge'::text, 'pledge_fulfil'::text, 'tab_settlement'::text, 'subscription_credit'::text, 'opening_balance'::text, 'dispute_stake'::text, 'dispute_stake_refund'::text, 'tab_settlement_reversal'::text]))
  GROUP BY account_id;

-- ---------------------------------------------------------------------------
-- (5) ledger_writer_earnings nets the two payout-reversal triggers so a writer's
-- (or inspirer's) earned total drops by what a chargeback claws back. Both are
-- negative entries, so summing them in is the whole correction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.ledger_writer_earnings AS
 SELECT account_id,
    (sum(amount_pence))::bigint AS earned_pence
   FROM public.ledger_entries
  WHERE (trigger_type = ANY (ARRAY['writer_payout'::text, 'publication_split'::text, 'tribute_payout'::text, 'writer_payout_reversal'::text, 'tribute_payout_reversal'::text]))
  GROUP BY account_id;
