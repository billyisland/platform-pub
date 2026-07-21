-- scripts/reconcile-ledger.sql
--
-- Architecture-audit item 3 (keystone) — Phase 2 penny-reconciliation.
--
-- Run against a migrated DB (prod, or a dev DB that has applied migration 120):
--   docker exec -i <postgres> psql -U platformpub -d platformpub -f - < scripts/reconcile-ledger.sql
--   (or: psql "$DATABASE_URL" -f scripts/reconcile-ledger.sql)
--
-- Two independent reconciliations:
--
--   PART A — ROW-LEVEL CONSISTENCY (must always be empty).
--     Every ledger entry must match its originating row in |amount_pence|. This
--     holds regardless of when the ledger started: it catches a dual-write that
--     posted the wrong magnitude or referenced the wrong row. ANY row returned
--     by Part A is a bug in the Phase-1 dual-write.
--
--   PART B — AGGREGATE BALANCE.
--     reader_balance vs reading_tabs.balance_pence (B1), and writer_earnings vs
--     the historic payout sums (B2).
--       • B1 (reader): post-migration-121 this MUST be empty. The Phase-3
--         opening-balance backfill seeded one opening_balance entry per tab so
--         −SUM(reader entries) == reading_tabs.balance_pence to the penny across
--         all history (and the subscription_credit gap is now mirrored too). A
--         nonzero B1 after 121 is a real bug — a tab movement missing its mirror.
--       • B2 (writer): still EXPECTED-nonzero. The writer side was NOT cut over
--         (ledger_writer_earnings sums money PAID OUT; the dashboard sums
--         earned-incl-pending — different quantities), so writer opening balances
--         were never backfilled. B2's diff = pre-Phase-1 un-backfilled payouts.

\echo '==================================================================='
\echo 'PART A — row-level ledger<->source consistency  (expect ZERO rows)'
\echo '==================================================================='

-- read_accrual / pledge_fulfil reference read_events; abs(amount) must equal
-- the read_events.amount_pence the entry recorded.
\echo '-- A1: read_accrual / pledge_fulfil vs read_events --'
SELECT le.trigger_type, le.id AS ledger_id, le.ref_id,
       le.amount_pence, re.amount_pence AS source_pence
FROM ledger_entries le
JOIN read_events re ON re.id = le.ref_id
WHERE le.trigger_type IN ('read_accrual', 'pledge_fulfil')
  AND abs(le.amount_pence) <> re.amount_pence;

\echo '-- A2: vote_charge vs vote_charges (amount + counterparty) --'
SELECT le.id AS ledger_id, le.ref_id,
       le.amount_pence, vc.amount_pence AS source_pence,
       le.counterparty_id, vc.recipient_id
FROM ledger_entries le
JOIN vote_charges vc ON vc.id = le.ref_id
WHERE le.trigger_type = 'vote_charge'
  AND (abs(le.amount_pence) <> vc.amount_pence
       OR le.counterparty_id IS DISTINCT FROM vc.recipient_id);

\echo '-- A3: tab_settlement vs tab_settlements --'
SELECT le.id AS ledger_id, le.ref_id,
       le.amount_pence, ts.amount_pence AS source_pence
FROM ledger_entries le
JOIN tab_settlements ts ON ts.id = le.ref_id
WHERE le.trigger_type = 'tab_settlement'
  AND le.amount_pence <> ts.amount_pence;

\echo '-- A4: writer_payout vs writer_payouts --'
SELECT le.id AS ledger_id, le.ref_id,
       le.amount_pence, wp.amount_pence AS source_pence,
       le.account_id, wp.writer_id
FROM ledger_entries le
JOIN writer_payouts wp ON wp.id = le.ref_id
WHERE le.trigger_type = 'writer_payout'
  AND (le.amount_pence <> wp.amount_pence
       OR le.account_id <> wp.writer_id);

\echo '-- A5: publication_split vs publication_payout_splits --'
SELECT le.id AS ledger_id, le.ref_id,
       le.amount_pence, ps.amount_pence AS source_pence,
       le.account_id, ps.account_id AS source_account
FROM ledger_entries le
JOIN publication_payout_splits ps ON ps.id = le.ref_id
WHERE le.trigger_type = 'publication_split'
  AND (le.amount_pence <> ps.amount_pence
       OR le.account_id <> ps.account_id);

-- A7: dispute_stake / dispute_stake_refund vs dispute_edges (Upstream Edges).
-- The stake is a debit (−) on the disputant's tab; the cited/credited author
-- never stakes; the holding dispute must reference the stake entry back.
\echo '-- A7: dispute_stake vs dispute_edges --'
SELECT le.id AS ledger_id, le.ref_id, le.amount_pence, le.account_id,
       de.disputant_account_id, de.is_by_cited_author, de.stake_ledger_entry_id
FROM ledger_entries le
JOIN dispute_edges de ON de.id = le.ref_id
WHERE le.trigger_type = 'dispute_stake'
  AND (le.account_id <> de.disputant_account_id
       OR le.amount_pence >= 0
       OR de.is_by_cited_author
       OR de.stake_ledger_entry_id IS DISTINCT FROM le.id);

-- A8: stake↔refund pairing. Every WITHDRAWN dispute that held a stake must have
-- exactly one paired dispute_stake_refund of equal magnitude, same account; a
-- refund with no withdrawn staked dispute is an orphan. A non-withdrawn staked
-- dispute legitimately has no refund (excluded by the stakes CTE filter).
\echo '-- A8: dispute stake↔refund pairing (expect ZERO) --'
WITH stakes AS (
  SELECT de.id AS dispute_id, de.disputant_account_id, le.amount_pence AS stake_pence
  FROM dispute_edges de
  JOIN ledger_entries le ON le.id = de.stake_ledger_entry_id
  WHERE de.withdrawn_at IS NOT NULL
), refunds AS (
  SELECT ref_id AS dispute_id, account_id, amount_pence AS refund_pence
  FROM ledger_entries WHERE trigger_type = 'dispute_stake_refund'
)
SELECT COALESCE(s.dispute_id, r.dispute_id) AS dispute_id,
       s.stake_pence, r.refund_pence
FROM stakes s
FULL OUTER JOIN refunds r ON r.dispute_id = s.dispute_id
WHERE s.dispute_id IS NULL
   OR r.dispute_id IS NULL
   OR s.disputant_account_id <> r.account_id
   OR abs(s.stake_pence) <> abs(r.refund_pence);

-- A9: tribute_payout vs tribute_payouts (Upstream Edges Phase 3). The entry
-- credits the inspirer (account_id), counterparty = the author whose earnings
-- were redirected, magnitude = the payout row.
\echo '-- A9: tribute_payout vs tribute_payouts --'
SELECT le.id AS ledger_id, le.ref_id,
       le.amount_pence, tp.amount_pence AS source_pence,
       le.account_id, tp.inspirer_account_id,
       le.counterparty_id, tp.author_account_id
FROM ledger_entries le
JOIN tribute_payouts tp ON tp.id = le.ref_id
WHERE le.trigger_type = 'tribute_payout'
  AND (le.amount_pence <> tp.amount_pence
       OR le.account_id <> tp.inspirer_account_id
       OR le.counterparty_id IS DISTINCT FROM tp.author_account_id);

-- A10 (Phase-5 chains): the gross-freeze + carve-at-payout model means a node's
-- accrual holds its GROSS inflow, but the node is paid its NET (gross − direct
-- children's gross). So the Phase-3 global "Σ paid accruals == Σ tribute_payout"
-- no longer holds (paid accruals sum to ALL gross; the ledger sums root gross).
-- It generalises to a PER-NODE conservation + a tree-wide telescoping, both AT
-- REST (a pending tribute_payout has claimed but not yet 'paid' its accruals, so
-- a transient nonzero during a cycle is expected — like B2's note).
--
-- A10a: for each node N, money paid out to N == N's paid gross − its DIRECT
-- children's paid gross (the onward carve). The author's depth-0 case is checked
-- separately by the writer_payout side; here we cover every tribute node.
\echo '-- A10a: per-node paid_out == node paid gross − direct children paid gross (expect ZERO at rest) --'
-- 'failed' is excluded alongside 'pending': handleFailedTributePayout rolls a
-- failed transfer's accruals back out of 'paid' (for re-pay) but leaves the
-- original +tribute_payout ledger entry in place (append-only), so a failed
-- payout's amount must not count as paid-out here (mirrors the writer path,
-- where a failed writer_payout's reads roll back the same way).
WITH paid_out AS (
  SELECT tribute_id, SUM(amount_pence) AS out_pence
  FROM tribute_payouts WHERE status NOT IN ('pending', 'failed') GROUP BY tribute_id
),
node_gross AS (
  SELECT tribute_id, SUM(amount_pence) AS gross
  FROM tribute_accruals WHERE state = 'paid' GROUP BY tribute_id
),
child_gross AS (
  SELECT t.parent_tribute_id AS tribute_id, SUM(ta.amount_pence) AS gross
  FROM tribute_accruals ta JOIN tributes t ON t.id = ta.tribute_id
  WHERE ta.state = 'paid' AND t.parent_tribute_id IS NOT NULL
  GROUP BY t.parent_tribute_id
)
SELECT COALESCE(po.tribute_id, ng.tribute_id) AS tribute_id,
       COALESCE(po.out_pence, 0) AS paid_out_pence,
       COALESCE(ng.gross, 0)     AS node_gross_paid,
       COALESCE(cg.gross, 0)     AS children_gross_paid
FROM paid_out po
FULL OUTER JOIN node_gross ng ON ng.tribute_id = po.tribute_id
LEFT JOIN child_gross cg ON cg.tribute_id = COALESCE(po.tribute_id, ng.tribute_id)
WHERE COALESCE(po.out_pence, 0) <> COALESCE(ng.gross, 0) - COALESCE(cg.gross, 0);

-- A10b: tree-wide telescoping. Σ(tribute_payout ledger for non-failed payouts)
-- == Σ(paid accruals of ROOT tributes): the chain only REDISTRIBUTES a root's
-- gross among the chain's nodes (Σ_N paid_out(N) = Σ paid(roots), the per-node
-- A10a summed). For a single (non-chained) tribute this reduces to the old
-- Phase-3 identity. The ledger sum excludes entries whose tribute_payout is
-- 'failed' — its accruals were rolled back out of 'paid' but its +entry stays
-- (see A10a's note).
\echo '-- A10b: Σ(tribute_payout ledger, non-failed) == Σ(root paid accruals) (expect ZERO at rest) --'
SELECT (SELECT COALESCE(SUM(le.amount_pence), 0)
          FROM ledger_entries le JOIN tribute_payouts tp ON tp.id = le.ref_id
         WHERE le.trigger_type = 'tribute_payout' AND tp.status <> 'failed') AS tribute_payout_pence,
       (SELECT COALESCE(SUM(ta.amount_pence), 0)
          FROM tribute_accruals ta JOIN tributes t ON t.id = ta.tribute_id
         WHERE ta.state = 'paid' AND t.parent_tribute_id IS NULL) AS root_paid_gross_pence
WHERE (SELECT COALESCE(SUM(le.amount_pence), 0)
          FROM ledger_entries le JOIN tribute_payouts tp ON tp.id = le.ref_id
         WHERE le.trigger_type = 'tribute_payout' AND tp.status <> 'failed')
   <> (SELECT COALESCE(SUM(ta.amount_pence), 0)
          FROM tribute_accruals ta JOIN tributes t ON t.id = ta.tribute_id
         WHERE ta.state = 'paid' AND t.parent_tribute_id IS NULL);

-- (Dial A retired A10c — the swept-return-kind consistency check. There is no
-- swept-return vehicle any more: a live tribute never un-consents, so no accrual
-- folds back to a parent, and swept_return_payout_id/kind were dropped in
-- migration 156.)

-- A11: a released/paid share is the beneficiary's deferred earning held OUTSIDE
-- the ledger (build-plan guard #7) — no ledger entry ever references a
-- tribute_accruals row; the only tribute ledger entry references tribute_payouts.
-- Any row here is an off-ledger-invariant breach.
\echo '-- A11: no ledger entry references tribute_accruals directly (expect ZERO) --'
SELECT id, trigger_type, ref_table, ref_id FROM ledger_entries WHERE ref_table = 'tribute_accruals';

\echo '-- A6: orphan entries — a ledger row whose source row is gone (expect ZERO) --'
SELECT le.id AS ledger_id, le.trigger_type, le.ref_table, le.ref_id
FROM ledger_entries le
WHERE (le.trigger_type IN ('read_accrual', 'pledge_fulfil')
         AND NOT EXISTS (SELECT 1 FROM read_events re WHERE re.id = le.ref_id))
   OR (le.trigger_type = 'vote_charge'
         AND NOT EXISTS (SELECT 1 FROM vote_charges vc WHERE vc.id = le.ref_id))
   OR (le.trigger_type = 'tab_settlement'
         AND NOT EXISTS (SELECT 1 FROM tab_settlements ts WHERE ts.id = le.ref_id))
   OR (le.trigger_type = 'writer_payout'
         AND NOT EXISTS (SELECT 1 FROM writer_payouts wp WHERE wp.id = le.ref_id))
   OR (le.trigger_type = 'publication_split'
         AND NOT EXISTS (SELECT 1 FROM publication_payout_splits ps WHERE ps.id = le.ref_id))
   OR (le.trigger_type IN ('dispute_stake', 'dispute_stake_refund')
         AND NOT EXISTS (SELECT 1 FROM dispute_edges de WHERE de.id = le.ref_id))
   OR (le.trigger_type = 'tribute_payout'
         AND NOT EXISTS (SELECT 1 FROM tribute_payouts tp WHERE tp.id = le.ref_id))
   -- Reversals resolve against the table each handler refs (ref_table), not all
   -- against tab_settlements. BOTH reversal triggers are multi-table:
   -- writer_payout_reversal is reused by F5 for publication-split-recipient
   -- reversals (ref_table 'publication_payout_splits'), and the chargeback
   -- planner posts writer_payout_reversal AND tribute_payout_reversal with
   -- ref_table 'tab_settlements'. Every branch must be ref_table-scoped — an
   -- unscoped branch flags the other handlers' rows as orphans forever (§0f 3).
   OR (le.trigger_type = 'tab_settlement_reversal'
         AND NOT EXISTS (SELECT 1 FROM tab_settlements ts WHERE ts.id = le.ref_id))
   OR (le.trigger_type = 'writer_payout_reversal' AND le.ref_table = 'writer_payouts'
         AND NOT EXISTS (SELECT 1 FROM writer_payouts wp WHERE wp.id = le.ref_id))
   OR (le.trigger_type = 'writer_payout_reversal' AND le.ref_table = 'publication_payout_splits'
         AND NOT EXISTS (SELECT 1 FROM publication_payout_splits ps WHERE ps.id = le.ref_id))
   OR (le.trigger_type = 'writer_payout_reversal' AND le.ref_table = 'tab_settlements'
         AND NOT EXISTS (SELECT 1 FROM tab_settlements ts WHERE ts.id = le.ref_id))
   OR (le.trigger_type = 'tribute_payout_reversal' AND le.ref_table = 'tribute_payouts'
         AND NOT EXISTS (SELECT 1 FROM tribute_payouts tp WHERE tp.id = le.ref_id))
   OR (le.trigger_type = 'tribute_payout_reversal' AND le.ref_table = 'tab_settlements'
         AND NOT EXISTS (SELECT 1 FROM tab_settlements ts WHERE ts.id = le.ref_id))
   -- Catch-all: ref_table-scoped branches are default-ALLOW — a reversal posted
   -- with a ref_table outside the known set matches no branch and is silently
   -- unchecked forever. The next F5-style trigger reuse must fail loud here
   -- (add its scoped branch above, then extend this list).
   OR (le.trigger_type = 'writer_payout_reversal'
         AND le.ref_table NOT IN ('writer_payouts', 'publication_payout_splits', 'tab_settlements'))
   OR (le.trigger_type = 'tribute_payout_reversal'
         AND le.ref_table NOT IN ('tribute_payouts', 'tab_settlements'));

-- A12: F3 reversal pairing. Every reversed settlement (reversed_at set) holds
-- exactly one reader-side reversal of −amount_pence (the restored debt), and no
-- un-reversed settlement carries any reversal entry. The writer/tribute reversal
-- entries (writer_payout_reversal / tribute_payout_reversal) ref the payout row
-- (writer_payouts / tribute_payouts), not the settlement, and are checked only
-- for orphans (A6) — their magnitudes are the per-node telescoped nets, not the
-- settlement total, so they are not summed here.
\echo '-- A12: reversed settlement ↔ tab_settlement_reversal pairing (expect ZERO) --'
WITH reversed AS (
  SELECT id, amount_pence FROM tab_settlements WHERE reversed_at IS NOT NULL
), reader_rev AS (
  SELECT ref_id AS settlement_id, SUM(amount_pence) AS rev_pence
  FROM ledger_entries WHERE trigger_type = 'tab_settlement_reversal'
  GROUP BY ref_id
)
SELECT COALESCE(rv.id, rr.settlement_id) AS settlement_id,
       rv.amount_pence AS settled_pence, rr.rev_pence
FROM reversed rv
FULL OUTER JOIN reader_rev rr ON rr.settlement_id = rv.id
WHERE rv.id IS NULL                                   -- reversal entry, no reversed settlement
   OR rr.settlement_id IS NULL                        -- reversed settlement, no reversal entry
   OR rr.rev_pence <> -rv.amount_pence;               -- magnitude mismatch

\echo
\echo '==================================================================='
\echo 'PART B — aggregate balance vs live tables'
\echo '  (B1 reader: MUST be empty post-migration-121; B2 writer: expected'
\echo '   nonzero = un-backfilled pre-Phase-1 payouts — see header)'
\echo '==================================================================='

\echo '-- B1: reader_balance view vs reading_tabs.balance_pence (expect ZERO post-121) --'
-- Full-outer over both sides so a tab with no ledger history (pre-Phase-1) and
-- a ledger account with no tab both surface. diff_pence = live − ledger.
SELECT COALESCE(rt.reader_id, rb.account_id)            AS account_id,
       COALESCE(rt.balance_pence, 0)                    AS tab_balance_pence,
       COALESCE(rb.balance_pence, 0)                    AS ledger_balance_pence,
       COALESCE(rt.balance_pence, 0) - COALESCE(rb.balance_pence, 0) AS diff_pence
FROM reading_tabs rt
FULL OUTER JOIN ledger_reader_balance rb ON rb.account_id = rt.reader_id
WHERE COALESCE(rt.balance_pence, 0) <> COALESCE(rb.balance_pence, 0)
ORDER BY abs(COALESCE(rt.balance_pence, 0) - COALESCE(rb.balance_pence, 0)) DESC
LIMIT 50;

\echo '-- B1 summary: total live tab debt vs total ledger debt --'
SELECT (SELECT COALESCE(SUM(balance_pence), 0) FROM reading_tabs)          AS live_total_pence,
       (SELECT COALESCE(SUM(balance_pence), 0) FROM ledger_reader_balance) AS ledger_total_pence,
       (SELECT COALESCE(SUM(balance_pence), 0) FROM reading_tabs)
         - (SELECT COALESCE(SUM(balance_pence), 0) FROM ledger_reader_balance) AS unbackfilled_pence;

\echo '-- B2: writer_earnings view vs flipped writer/publication payouts --'
-- Ledger entries are emitted on the pending->initiated flip, so the live anchor
-- is the sum of non-pending payout rows. diff = live − ledger.
WITH live AS (
  SELECT writer_id AS account_id, SUM(amount_pence) AS pence
  FROM writer_payouts WHERE status <> 'pending' GROUP BY writer_id
  UNION ALL
  SELECT account_id, SUM(amount_pence)
  FROM publication_payout_splits WHERE status <> 'pending' GROUP BY account_id
  UNION ALL
  -- Inspirer tribute payouts (Upstream Edges Phase 3): the ledger posts the
  -- tribute_payout entry on the pending→initiated flip, so the live anchor is
  -- the non-pending rows, keyed by the credited inspirer.
  SELECT inspirer_account_id, SUM(amount_pence)
  FROM tribute_payouts WHERE status <> 'pending' GROUP BY inspirer_account_id
), live_by_account AS (
  SELECT account_id, SUM(pence)::bigint AS earned_pence FROM live GROUP BY account_id
)
SELECT COALESCE(l.account_id, e.account_id)        AS account_id,
       COALESCE(l.earned_pence, 0)                 AS live_earned_pence,
       COALESCE(e.earned_pence, 0)                 AS ledger_earned_pence,
       COALESCE(l.earned_pence, 0) - COALESCE(e.earned_pence, 0) AS diff_pence
FROM live_by_account l
FULL OUTER JOIN ledger_writer_earnings e ON e.account_id = l.account_id
WHERE COALESCE(l.earned_pence, 0) <> COALESCE(e.earned_pence, 0)
ORDER BY abs(COALESCE(l.earned_pence, 0) - COALESCE(e.earned_pence, 0)) DESC
LIMIT 50;

\echo '-- B3: platform behaviour-tax collected (informational) --'
SELECT COALESCE(SUM(tax_paid_pence), 0) AS total_behaviour_tax_pence
FROM ledger_platform_tax;

\echo '-- done --'
