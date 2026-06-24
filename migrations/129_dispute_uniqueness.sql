-- 129_dispute_uniqueness.sql
--
-- Upstream Edges — audit fix F1 (dispute uniqueness).
-- Companion: docs/adr/UPSTREAM-EDGES-AUDIT-FIXES.md › F1.
--
-- POST /disputes had no "already disputed?" guard and dispute_edges carried no
-- uniqueness constraint, so one account could dispute the same edge N times: a
-- third party self-charged £5 each but bumped the public thirdPartyCount on
-- every repeat, and a cited author (no stake) could inflate the disclaimer /
-- dispute counts the GET endpoints render for free, without limit.
--
-- One active dispute per (disputant, target edge). "Active" excludes withdrawn
-- and soft-deleted rows — re-disputing after a withdrawal stays allowed (the
-- withdrawal path refunds any stake, so a fresh dispute holds a fresh stake).
-- Two partial indexes because exactly one of citation_edge_id / credit_edge_id
-- is ever set on a row (dispute_edges_single_target), so a single composite key
-- would not collapse the two target kinds.

CREATE UNIQUE INDEX uq_dispute_active_citation
  ON public.dispute_edges (disputant_account_id, citation_edge_id)
  WHERE citation_edge_id IS NOT NULL
    AND withdrawn_at IS NULL
    AND deleted_at IS NULL;

CREATE UNIQUE INDEX uq_dispute_active_credit
  ON public.dispute_edges (disputant_account_id, credit_edge_id)
  WHERE credit_edge_id IS NOT NULL
    AND withdrawn_at IS NULL
    AND deleted_at IS NULL;
