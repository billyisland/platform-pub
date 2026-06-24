-- 132_read_state_charged_back.sql
--
-- F3 (reader chargeback/refund reversal) — step 1 of 2: the new read_state.
--
-- A reversed read leaves the earning flow entirely: it is neither accruing,
-- settled, nor paid — it is terminally CHARGED BACK. Adding the enum value is
-- isolated in its own migration because `ALTER TYPE … ADD VALUE` forces the
-- runner to apply the WHOLE file outside a transaction (shared/src/db/migrate.ts
-- — it cannot run inside BEGIN/COMMIT). Migration 133 carries the rest of the
-- F3 schema transactionally, and uses this value.
--
-- Companion: docs/adr/UPSTREAM-EDGES-AUDIT-FIXES.md (F3),
-- docs/adr/UPSTREAM-EDGES-ADR.md (Edge cases — Refund / chargeback).

ALTER TYPE public.read_state ADD VALUE IF NOT EXISTS 'charged_back';
