-- 167_publication_split_repay.sql
--
-- Publication-split re-pay after a terminal Stripe rejection.
-- Queue item: CONSOLIDATED-TODO §1.2. Cycle spec: FUNDS-SEGREGATION-INTEGRATION §3.4.
--
-- THE PROBLEM THIS SOLVES. A publication split that Stripe terminally rejects at
-- create time is marked 'failed' and left there. Nothing retries it, and nothing
-- can: the idempotency key is `pub-split-${payoutId}-${splitId}`, deliberately
-- row-stable so an ambiguous failure can be retried safely by the resume sweep
-- (2026-07-15 audit) — which means a retry against the SAME row would dedupe
-- straight back onto the transfer that was rejected. So a correct re-pay has to
-- mint a FRESH split row, whose new id yields a new key.
--
-- Nor does the money come back on its own. Unlike a writer or tribute payout,
-- whose units are released child by child so the next cycle re-pays them under a
-- fresh parent, a split owns no claim rows: the publication cycle claims its
-- reads under the PAYOUT, and a split is a bps share of the resulting pool. There
-- is no per-read decomposition to release, so the member's money stays claimed by
-- a payout that has already completed, and they are simply short.
--
-- WHY A REPLACEMENT ROW IS SAFE. Every consumer of this table already filters on
-- status, so a superseded 'failed' row is invisible to all of them:
--   · ledger_publication_distribution sums LEDGER entries, and a failed split
--     posts none (the entry rides the pending→completed flip);
--   · the F5 chargeback proration selects status IN ('completed','reversed');
--   · settlement.ts's distribution read selects status IN ('initiated','completed');
--   · PUBLICATION_PAYOUT_COMPLETE_SQL keys on "no split PENDING".
-- The one thing a replacement DOES change is that last rule — a fresh pending
-- split on a completed parent must reopen it, or the resume sweep (which scans
-- 'pending' parents only) will never process the row. The service layer does that
-- in the same transaction that mints the row.
--
-- WHAT THESE TWO COLUMNS ARE FOR.
--
--   attempt               Bounds the retry. Without it a permanently broken
--                         destination — a closed or rejected connected account,
--                         which is exactly what a terminal rejection usually
--                         means — would mint a new row and call Stripe every
--                         cycle, forever. The replacement carries its
--                         predecessor's attempt + 1 and the sweep stops at a cap,
--                         leaving the last failure in place for a human.
--
--   replaced_by_split_id  Makes the supersession explicit rather than inferred.
--                         Without it, "has this failed split already been
--                         re-paid?" is a guess from (payout, account, share_type,
--                         article_id) — and computePublicationSplits can legally
--                         emit two splits for one account in one payout (a
--                         standing member who also holds an article share), which
--                         is the same collision that made the idempotency key
--                         row-stable in the first place. A direct pointer cannot
--                         be confused by it, and it gives support a chain to read.
--
-- Both are nullable/defaulted, so every historical row is a first attempt that
-- has not been replaced — which is exactly what it is.

ALTER TABLE publication_payout_splits
  ADD COLUMN attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN replaced_by_split_id uuid REFERENCES publication_payout_splits(id);

COMMENT ON COLUMN publication_payout_splits.attempt IS
  'Re-pay attempt number, 1 for an originally computed split. A replacement minted after a terminal Stripe rejection carries its predecessor''s attempt + 1; the re-pay sweep refuses to mint past a cap so a permanently broken destination cannot be retried forever.';

COMMENT ON COLUMN publication_payout_splits.replaced_by_split_id IS
  'Set on a failed split when a replacement has been minted for it, pointing at that replacement. NULL means never re-paid. Explicit rather than inferred, because one account can legally hold two splits in one payout (standing + article share).';

-- The sweep's candidate query: failed, not yet superseded, under the cap. Partial
-- so it indexes only the rows the sweep can act on, which on a healthy platform
-- is none of them.
CREATE INDEX idx_pub_split_repay_candidates
  ON publication_payout_splits (publication_payout_id)
  WHERE status = 'failed' AND replaced_by_split_id IS NULL;
