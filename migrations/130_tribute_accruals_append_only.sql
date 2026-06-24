-- 130_tribute_accruals_append_only.sql
--
-- Upstream Edges audit fix F4 — give tribute_accruals the DB-level immutability
-- guard its money-bearing siblings already carry.
--
-- tribute_accruals.amount_pence is frozen at settlement ("fee bps of the moment,
-- never recomputed") and the row's identity (tribute_id, read_event_id) keys the
-- one-accrual-per-settled-read invariant. ledger_entries is DB-guarded against
-- UPDATE/DELETE/TRUNCATE (migrations 119/124); this table is freely mutable, so
-- a future write path could silently recompute a frozen amount or re-point an
-- accrual at a different read/tribute and nothing would notice.
--
-- Unlike ledger_entries, accruals are NOT fully append-only: the lifecycle
-- (held → released/swept → paid/returned) is realised by UPDATEing `state`, and
-- the two payout-claim columns (tribute_payout_id / author_return_payout_id) are
-- set at reserve and rolled back on a failed transfer. So this is a PARTIAL
-- guard: it blocks DELETE/TRUNCATE outright and blocks UPDATEs that change the
-- frozen/identity columns, while allowing state + claim-column writes.

CREATE OR REPLACE FUNCTION tribute_accruals_protect() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION
      'tribute_accruals is append-only: % is not permitted (advance state / claim columns instead)',
      TG_OP;
  END IF;
  -- UPDATE: the frozen amount and the row's identity may never change.
  IF NEW.amount_pence IS DISTINCT FROM OLD.amount_pence THEN
    RAISE EXCEPTION 'tribute_accruals.amount_pence is frozen at settlement and cannot be changed';
  END IF;
  IF NEW.tribute_id IS DISTINCT FROM OLD.tribute_id
     OR NEW.read_event_id IS DISTINCT FROM OLD.read_event_id THEN
    RAISE EXCEPTION 'tribute_accruals identity (tribute_id, read_event_id) is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tribute_accruals_protect_row_trg
  BEFORE UPDATE OR DELETE ON public.tribute_accruals
  FOR EACH ROW EXECUTE FUNCTION tribute_accruals_protect();

CREATE TRIGGER tribute_accruals_protect_stmt_trg
  BEFORE TRUNCATE ON public.tribute_accruals
  FOR EACH STATEMENT EXECUTE FUNCTION tribute_accruals_protect();
