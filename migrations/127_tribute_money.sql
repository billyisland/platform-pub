-- 127_tribute_money.sql
--
-- Upstream Edges — Phase 3: tribute money flow (settlement apportionment +
-- author/inspirer payout). Companion: docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md
-- (Phase 3), docs/adr/UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md (the held-funds
-- position the money phase ships under). Ships dark behind TRIBUTES_ENABLED; the
-- production money flag is a separate compliance sign-off (memo residual #1).
--
-- This migration is schema-only. The money MOVEMENTS live in code:
--   • settlement apportionment — payment-service confirmSettlement inserts frozen
--     tribute_accruals rows for newly-settled tributed reads.
--   • author carve + swept-return — payout.ts runPayoutCycle.
--   • inspirer payout — payout.ts runTributePayoutCycle (this migration's
--     tribute_payouts table).
--
-- CONSERVATION MODEL (the keystone, per the build plan's named reconcile
-- "author-share + Σ accruals == read net"):
--   The author's per-read carve subtracts Σ(ALL accruals on the read) — there is
--   NO state filter on the carve. Each accrual's eventual disposition is the
--   second leg that closes conservation:
--     · released → paid    : the inspirer's share, paid by runTributePayoutCycle
--                            (one tribute_payout ledger entry per inspirer payout).
--     · swept    → returned: declined/lapsed share, returned to the AUTHOR, folded
--                            into the author's writer_payout (no separate transfer).
--   Carving ALL accruals (not "held|released|paid") is the only ordering-safe
--   realization: a read and its accrual reach terminal state at different times
--   and in either order, so a state-filtered carve double-counts a swept share.
--   The author DISPLAY paths carve held|released|paid only (swept/returned are the
--   author's), so display and money converge on author = read_net − (held|released|paid).

-- ---------------------------------------------------------------------------
-- (1) tribute_accruals: add the 'returned' terminal state (a swept share that
--     has been returned to the author in a payout), and the two payout-claim
--     columns that make each disposition exactly-once (mirroring how read_events
--     claim a writer_payout via writer_payout_id):
--       · tribute_payout_id        — released accrual claimed by an inspirer payout
--       · author_return_payout_id  — swept accrual claimed by the author's payout
--     A column is set at reserve (claim), the state advances at complete, both
--     roll back on a failed transfer. tribute_payout_id is added below the
--     tribute_payouts table it references.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tribute_accruals
  DROP CONSTRAINT tribute_accruals_state_check,
  ADD CONSTRAINT tribute_accruals_state_check
    CHECK (state IN ('held', 'released', 'paid', 'swept', 'returned'));

-- ---------------------------------------------------------------------------
-- (2) tribute_payouts — the inspirer-payment record, mirroring writer_payouts:
--     reserve a 'pending' row + claim the released accruals, create the Stripe
--     Connect transfer with a stable idempotency key, then flip 'initiated' and
--     post one tribute_payout ledger entry. Real money to a third party, so it
--     gets the same crash-safe three-phase durability as every other payout.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tribute_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tribute_id uuid NOT NULL REFERENCES public.tributes(id),
  inspirer_account_id uuid NOT NULL REFERENCES public.accounts(id),  -- the resolved, onboarded payee
  author_account_id uuid NOT NULL REFERENCES public.accounts(id),    -- ledger counterparty (whose earnings were redirected)
  amount_pence bigint NOT NULL,
  stripe_transfer_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'initiated', 'failed')),
  failed_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tribute_payouts_tribute ON public.tribute_payouts(tribute_id);
-- The cycle resumes 'pending' rows from a prior crash.
CREATE INDEX idx_tribute_payouts_status ON public.tribute_payouts(status)
  WHERE status = 'pending';

-- The two accrual-claim columns (added now that both referenced tables exist).
ALTER TABLE public.tribute_accruals
  ADD COLUMN tribute_payout_id uuid REFERENCES public.tribute_payouts(id),
  ADD COLUMN author_return_payout_id uuid REFERENCES public.writer_payouts(id);

-- Reserve claims by these columns WHERE ... IS NULL, so partial indexes keep the
-- per-cycle reselection of unclaimed accruals cheap.
CREATE INDEX idx_tribute_accruals_released_unclaimed
  ON public.tribute_accruals(tribute_id)
  WHERE state = 'released' AND tribute_payout_id IS NULL;
CREATE INDEX idx_tribute_accruals_swept_unclaimed
  ON public.tribute_accruals(tribute_id)
  WHERE state = 'swept' AND author_return_payout_id IS NULL;

-- ---------------------------------------------------------------------------
-- (3) ledger_writer_earnings: count tribute_payout so the inspirer's redirected
--     share registers as earnings (build-plan guard #5). The author's reduced
--     writer_payout already reflects the carve, so no author-side view change is
--     needed. Columns unchanged ⇒ CREATE OR REPLACE is safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.ledger_writer_earnings AS
SELECT account_id,
       SUM(amount_pence)::bigint AS earned_pence
FROM public.ledger_entries
WHERE trigger_type IN ('writer_payout', 'publication_split', 'tribute_payout')
GROUP BY account_id;
