-- 119_ledger_entries.sql
--
-- Architecture-audit 2026-06-15 item 3 (keystone) — Phase 0: table + guard.
--
-- One append-only ledger so "how does writer X make a living here?" is a single
-- query, not a hand-union of eight money surfaces. Balances become SUM() views
-- (Phase 2). This migration adds ONLY the table, its indexes, and the
-- append-only guard — no reads, no dual-write yet (those are Phases 1–3, each
-- shippable and non-breaking until the cutover). So this is inert on its own:
-- nothing writes ledger_entries until Phase 1 wires the money paths.
--
-- Shape (from the audit ground-truth). Every row is one money MOVEMENT:
--   amount_pence is SIGNED — (+) credit to account_id, (−) debit. A balance is
--   then SUM(amount_pence) over an account. trigger_type names the economic
--   event; (ref_table, ref_id) point back at the originating row so the ledger
--   is reconcilable against the live tables it mirrors. counterparty_id is the
--   other side of the movement (NULL when the counterparty is the platform).
--
-- Scope correction carried from the plan: dm_pricing is a PRICE BOOK, not a
-- money movement (no funds flow through it) — it is NOT a ledger source. The
-- real events are reads, settlements, writer/publication payouts + splits, vote
-- charges, and pledge fulfilment (wired in Phase 1).
--
-- Append-only discipline: corrections are REVERSING entries, never UPDATE/DELETE.
-- A BEFORE UPDATE OR DELETE trigger raises — mirroring how migration 098 makes
-- the DB the sole authority over feed_items identity. (pgcrypto for
-- gen_random_uuid() is already present from 098.)

CREATE TABLE ledger_entries (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL REFERENCES accounts(id),   -- whose ledger
  counterparty_id uuid        REFERENCES accounts(id),            -- other side (NULL = platform)
  amount_pence    bigint      NOT NULL,                           -- signed: (+) credit, (−) debit
  currency        text        NOT NULL DEFAULT 'GBP',
  trigger_type    text        NOT NULL,   -- 'read_accrual','tab_settlement','writer_payout',
                                          -- 'publication_split','vote_charge','pledge_fulfil', …
  ref_table       text        NOT NULL,   -- originating table
  ref_id          uuid        NOT NULL,   -- originating row
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Per-account balance/history scan (Phase 2 SUM views key off this).
CREATE INDEX idx_ledger_entries_account_created ON ledger_entries (account_id, created_at);
-- Reconciliation: find the ledger entry for an originating row.
CREATE INDEX idx_ledger_entries_ref ON ledger_entries (ref_table, ref_id);
-- Slice by economic event (platform_tax, writer_earnings, …).
CREATE INDEX idx_ledger_entries_trigger_type ON ledger_entries (trigger_type);

-- ── append-only guard ───────────────────────────────────────────────────────
-- The ledger is immutable: a posted movement is never edited or removed; a
-- mistake is corrected by appending a reversing entry. Enforce in the DB so no
-- write path (present or future) can mutate history.
CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only: % is not permitted (post a reversing entry instead)',
    TG_OP;
END;
$$;

CREATE TRIGGER ledger_entries_append_only_trg
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();
