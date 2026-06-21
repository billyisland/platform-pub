-- 124_ledger_negative_balance_and_truncate_guard.sql
--
-- Architecture-audit 2026-06-20 four-day-commit findings — keystone follow-up.
--
-- Two structural fixes that make the Phase-3 "−SUM(ledger) == reading_tabs
-- .balance_pence to the penny" invariant hold by construction rather than be
-- defended by per-write clamps.
--
-- 1. DROP the reading_tabs_balance_non_negative CHECK (added in migration 086).
--    POLICY: reading_tabs.balance_pence is allowed to go negative. Negative
--    means "platform owes the reader / pre-paid credit" — legitimate for an
--    over-settlement or a subscription credit-back beyond current debt. With the
--    CHECK live, the three money paths that mirror the ledger with the SAME
--    signed delta either (a) clamped at 0 and silently diverged from the ledger
--    (settlement) or (b) aborted with 23514 when the delta would cross zero
--    (subscription credit-back). Dropping the clamps without dropping this CHECK
--    would turn (a) into (b). The ledger is the truth; the column tracks it
--    identically; over-payments surface as reader credit instead of being
--    absorbed. (Code side: settlement.ts / subscription-convert.ts drop their
--    clamp/abort; drives.ts upserts the tab so the row always exists.)
--
-- 2. ADD a BEFORE TRUNCATE guard to ledger_entries. The append-only trigger from
--    migration 119 is BEFORE UPDATE OR DELETE ... FOR EACH ROW, so a TRUNCATE
--    (statement-level, fires no row trigger) slipped past the "DB-enforced
--    append-only" invariant. The existing ledger_entries_append_only() function
--    already raises on any TG_OP textually, so this is just a second trigger
--    binding it at statement level — no function change.

ALTER TABLE reading_tabs DROP CONSTRAINT reading_tabs_balance_non_negative;

CREATE TRIGGER ledger_entries_no_truncate_trg
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_append_only();
