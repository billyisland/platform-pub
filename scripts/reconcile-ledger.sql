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
         AND NOT EXISTS (SELECT 1 FROM dispute_edges de WHERE de.id = le.ref_id));

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
