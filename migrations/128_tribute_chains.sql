-- 128_tribute_chains.sql
--
-- Upstream Edges — Phase 5: tribute chains (recursive re-division).
-- Companion: docs/adr/UPSTREAM-EDGES-ADR.md › "Tribute chains (recursive
-- re-division)" (Decision 13, C1–C6); docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md
-- (Phase 5). Ships dark behind the same TRIBUTES_ENABLED flag as Phases 2–4 —
-- no new compliance question (C6: the held-funds position recurses one level up
-- the tree; every held share is still some CONSENTED earner's deferred earnings
-- under a revocable redirect, guaranteed by C1).
--
-- THE KEYSTONE REFRAMING: the article author was always the depth-0 case of "a
-- party that carves its direct children's shares off its inflow." Phase 3 only
-- ever had depth 0 (the author carving its root tributes). Phase 5 lets the tree
-- go deeper and makes EVERY node — author included — run the same carve. So this
-- is a uniform generalisation of the shipped model, not a new mechanism.
--
-- This migration is the SCHEMA half (5a). The recursive money MOVEMENTS live in
-- code (5b): the recursive settlement walk (payment-service confirmSettlement),
-- the level-aware carve (payout.ts runPayoutCycle / runTributePayoutCycle), and
-- the C5 swept-return-to-the-parent fold. No new LedgerTriggerType, no new
-- adjacency MARKER (the freeze stays an INSERT INTO tribute_accruals driven by a
-- recursive SELECT; payouts stay INSERT INTO tribute_payouts).

-- ---------------------------------------------------------------------------
-- (1) tributes.parent_tribute_id — the tree edge.
--
--   NULL     = a ROOT tribute (today's behaviour: its source-of-funds is the
--              piece's writer-side net).
--   non-NULL = a CHILD: its source-of-funds is the PARENT tribute's share, not
--              the piece net. The structure is a tree rooted at the piece; each
--              root→leaf path is one chain.
--
-- percentage_bps keeps ONE meaning at every level: the share of the parent's
-- inflow (the piece net being the implicit parent inflow for roots), so no
-- column rename. A single parent pointer makes the structure acyclic by
-- construction (a child points only at a pre-existing parent stream; C4).
--
-- The WIDENED meaning of author_account_id (no DDL): for a root it is the
-- article author; for a CHILD it is the PARENT's beneficiary — the offerer
-- redirecting *their* share, i.e. the parent tribute's resolved_account_id. It
-- stays "whoever is paying this share out of their slice" and remains the
-- tribute_payout ledger counterparty.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tributes
  ADD COLUMN parent_tribute_id uuid REFERENCES public.tributes(id),
  -- depth = parent.depth + 1 on insert (the authoring route sets it from the
  -- parent row it already loads — cheaper than a per-insert recursive walk).
  -- The cap (8, C4) bounds the recursive settlement walk and stops sub-penny
  -- dust chains; enforced in the route AND by this CHECK backstop.
  ADD COLUMN depth int NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 8);

-- The child-listing + parent-scoped ceiling lookup.
CREATE INDEX idx_tributes_parent ON public.tributes(parent_tribute_id);

-- ---------------------------------------------------------------------------
-- (2) Generalise the ceiling trigger from article-scoped to PARENT-scoped (C3).
--
-- The Σ percentage_bps ≤ 9000 sum (every node retains ≥10% of its OWN inflow)
-- regroups by the parent stream: roots (parent NULL) still group by article_id
-- AMONG ROOTS; children group by parent_tribute_id. So a share is never fully
-- drained past the node that accepted it. The D1-forward branch is unchanged
-- (it still applies to the whole chain — one non-publication piece carries it).
-- The articles D1-reverse trigger is untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tributes_validate_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  total int;
  ceiling int := 9000;  -- each node keeps >= 10% of its inflow
BEGIN
  -- A row that no longer reserves a share imposes neither constraint.
  IF NEW.deleted_at IS NOT NULL OR NEW.status IN ('declined', 'lapsed') THEN
    RETURN NEW;
  END IF;
  -- (1) D1 forward: reject a tribute on an article that is in a publication.
  IF EXISTS (
    SELECT 1 FROM public.articles a
     WHERE a.id = NEW.article_id AND a.publication_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Article % is in a publication; it cannot carry a tribute (D1)',
      NEW.article_id USING ERRCODE = 'check_violation';
  END IF;
  -- (2) Parent-scoped share ceiling. Roots compete among the article's roots;
  -- children compete among their siblings under the same parent.
  IF NEW.parent_tribute_id IS NULL THEN
    SELECT COALESCE(SUM(percentage_bps), 0) INTO total
      FROM public.tributes
     WHERE article_id = NEW.article_id
       AND parent_tribute_id IS NULL
       AND id <> NEW.id
       AND deleted_at IS NULL
       AND status IN ('proposed', 'live');
  ELSE
    SELECT COALESCE(SUM(percentage_bps), 0) INTO total
      FROM public.tributes
     WHERE parent_tribute_id = NEW.parent_tribute_id
       AND id <> NEW.id
       AND deleted_at IS NULL
       AND status IN ('proposed', 'live');
  END IF;
  IF total + NEW.percentage_bps > ceiling THEN
    RAISE EXCEPTION
      'Tribute shares would exceed the ceiling under this parent (have % bps, adding % bps, ceiling % bps)',
      total, NEW.percentage_bps, ceiling
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- (3) C5's swept-return vehicle — the ONE new money plumbing.
--
-- Today a swept share folds back into the AUTHOR's writer_payouts run via
-- tribute_accruals.author_return_payout_id → writer_payouts(id). A deeper
-- child's swept share must instead fold into its PARENT INSPIRER's
-- tribute_payouts run. A single strict FK can't reference both tables, so the
-- claim becomes a polymorphic soft-ref (matching the schema's existing
-- target_protocol/resolved_account_id polymorphic grammar):
--
--   swept_return_payout_id uuid  — the claiming payout row (writer_payouts OR
--                                  tribute_payouts, per the discriminator)
--   swept_return_kind text       — 'writer' (depth-0 author) | 'tribute' (a
--                                  deeper inspirer parent)
--
-- DECIDED (ADR C5): ONE generic "return to the parent's payout" path; the author
-- is simply the depth-0 case (its payout is a writer_payouts run), NOT a parallel
-- column. So author_return_payout_id (which was exactly the writer-kind case) is
-- folded into this pair. The carve and reconcile read the kind to know which
-- payouts table to join.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tribute_accruals
  ADD COLUMN swept_return_payout_id uuid,   -- polymorphic soft-ref (no FK: two possible parents)
  ADD COLUMN swept_return_kind text
    CHECK (swept_return_kind IN ('writer', 'tribute')),
  -- The claim is all-or-nothing: a returned/claimed accrual carries both the
  -- payout id and its kind; an unclaimed one carries neither.
  ADD CONSTRAINT tribute_accruals_swept_return_consistency
    CHECK ((swept_return_payout_id IS NULL) = (swept_return_kind IS NULL));

-- Fold the existing writer-kind claims into the generic pair, then drop the
-- single-FK column it replaces. (On a fresh/empty DB this UPDATE is a no-op.)
UPDATE public.tribute_accruals
   SET swept_return_payout_id = author_return_payout_id,
       swept_return_kind = 'writer'
 WHERE author_return_payout_id IS NOT NULL;

-- The partial "swept + unclaimed" index keyed off the old column; redefine it on
-- the new generic claim before dropping the column it referenced.
DROP INDEX IF EXISTS public.idx_tribute_accruals_swept_unclaimed;

ALTER TABLE public.tribute_accruals
  DROP COLUMN author_return_payout_id;

CREATE INDEX idx_tribute_accruals_swept_unclaimed
  ON public.tribute_accruals(tribute_id)
  WHERE state = 'swept' AND swept_return_payout_id IS NULL;

-- (The released-unclaimed partial index — idx_tribute_accruals_released_unclaimed
-- on (tribute_id) WHERE state='released' AND tribute_payout_id IS NULL — is
-- unchanged in shape: the per-cycle reselection of released accruals recurses
-- identically.)
