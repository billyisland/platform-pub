-- 147: backfill legacy 'initiated' payouts to 'completed' (2026-07-06 audit,
-- F4 follow-on)
--
-- Before F4 (commit 393b35b) every payout stalled at 'initiated' forever: the
-- old flow waited for a transfer.paid webhook Stripe never emits for
-- platform→connected transfers. F4 keys completion off the transfers.create
-- response for NEW payouts, but shipped no backfill — so every historical paid
-- payout still sits at 'initiated', where:
--
--   • the F4 reverse* handlers (transfer.reversed) match only
--     status = 'completed' — a clawback on any historical payout is a silent
--     no-op that never reaches the ledger;
--   • the kept transfer.failed no-op branches guard status != 'completed',
--     which still matches 'initiated' — if that webhook ever fires, a
--     genuinely-paid legacy payout gets rolled back and the next cycle
--     double-pays with no reversing entry.
--
-- A stored stripe_transfer_id is the proof the transfer was created (it is
-- only written after a successful transfers.create), so those rows are
-- completed in every sense but the label. 'initiated' rows WITHOUT a transfer
-- id (a pre-F4 crash between reserve and create) are deliberately left alone:
-- calling them completed would fabricate a payment. completed_at falls back to
-- created_at — approximate, but strictly better than NULL on a completed row.
--
-- publication_payout_splits predate F4 with per-split transfer ids; same rule.
-- The parent publication_payouts flip mirrors finalisePublicationPayout: only
-- when every split is 'completed'. tribute_payouts get the same treatment for
-- symmetry (tributes are dark in prod, so this is expected to touch 0 rows).

UPDATE writer_payouts
SET status = 'completed',
    completed_at = COALESCE(completed_at, created_at)
WHERE status = 'initiated'
  AND stripe_transfer_id IS NOT NULL;

UPDATE publication_payout_splits
SET status = 'completed'
WHERE status = 'initiated'
  AND stripe_transfer_id IS NOT NULL;

UPDATE publication_payouts pp
SET status = 'completed',
    completed_at = COALESCE(pp.completed_at, pp.created_at)
WHERE pp.status = 'initiated'
  AND NOT EXISTS (
    SELECT 1 FROM publication_payout_splits s
    WHERE s.publication_payout_id = pp.id
      AND s.status <> 'completed'
  );

UPDATE tribute_payouts
SET status = 'completed',
    completed_at = COALESCE(completed_at, created_at)
WHERE status = 'initiated'
  AND stripe_transfer_id IS NOT NULL;
