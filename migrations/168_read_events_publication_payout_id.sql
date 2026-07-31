-- =============================================================================
-- 168 — read_events.publication_payout_id
--
-- THE BUG THIS FIXES: the publication payout cycle has never been able to pay a
-- read-funded pool, since the day it was written.
--
-- `reservePublicationPayout` claims the pool's reads with
--
--     UPDATE read_events SET writer_payout_id = $1 ...
--
-- where `$1` is a **publication_payouts** id. But that column carries
-- `fk_read_events_writer_payout REFERENCES writer_payouts(id)`, so every such
-- UPDATE raises 23503 and rolls back the whole reserve transaction. The FK is in
-- the schema.sql genesis and no migration ever altered it.
--
-- It failed SILENTLY: `runPublicationPayoutCycle` catches per-publication errors
-- and logs, so the worker survives and the only observable symptom is that
-- publications are never paid. A subscription-only pool survived, because that
-- claim already used `subscription_events.publication_payout_id` — a column that
-- exists. THAT ASYMMETRY IS THE WHOLE FIX: the subscription side was given a
-- dedicated column and the reads side was left borrowing the writer's.
--
-- Found 2026-07-31 by the §5 sandbox sequence (step 11), which is the first thing
-- ever to call `runPublicationPayoutCycle` against a real database — no test in
-- the repo does, which is exactly why every unit test passed while the feature
-- had never once run.
--
-- WHY A NEW COLUMN RATHER THAN DROPPING THE FK. Making `writer_payout_id`
-- polymorphic would be one line, but it abandons referential integrity on a money
-- path and leaves a column whose name actively misleads about what it holds. The
-- two cycles are exact complements (CLAUDE.md, "the publication pool and the
-- individual writer cycle"), so their claims should be two columns that cannot be
-- confused, mirroring `subscription_events`, which has held both since it was
-- written.
--
-- NO BACKFILL IS POSSIBLE OR NEEDED. The FK made it impossible for any row to
-- carry a publication payout id in `writer_payout_id`, so there is nothing to
-- migrate: every existing row's `publication_payout_id` correctly starts NULL.
-- Production has zero publication payouts in any case.
--
-- ON DELETE SET NULL mirrors `fk_read_events_writer_payout` exactly: deleting a
-- payout releases its claim rather than cascading into the read history.
-- =============================================================================

ALTER TABLE read_events
  ADD COLUMN publication_payout_id uuid;

ALTER TABLE read_events
  ADD CONSTRAINT fk_read_events_publication_payout
  FOREIGN KEY (publication_payout_id)
  REFERENCES publication_payouts(id)
  ON DELETE SET NULL;

-- The pool's hot predicate is "settled, unclaimed, for this publication", and the
-- claim/finalise/recompute paths all filter on this column. Partial, because the
-- overwhelming majority of reads are personal and never carry one.
CREATE INDEX idx_read_events_publication_payout
  ON read_events (publication_payout_id)
  WHERE publication_payout_id IS NOT NULL;

COMMENT ON COLUMN read_events.publication_payout_id IS
  'The publication payout that claimed this read. The publication twin of writer_payout_id: the two cycles are exact complements, and a read is claimed by exactly one of them. Never reuse writer_payout_id for a publication payout — its FK points at writer_payouts and the UPDATE raises 23503 (migration 168).';
