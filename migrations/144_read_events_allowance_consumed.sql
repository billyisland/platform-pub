-- 144_read_events_allowance_consumed.sql
--
-- F14 (allowance-split modelling). read_events previously recorded only a coarse
-- boolean on_free_allowance, which flagged the WHOLE read as "on allowance"
-- whenever any allowance remained — so a 10p read against a 5p balance was
-- mis-recorded as fully free. Model the split explicitly: allowance_consumed_pence
-- is the genuinely-free portion of the read = max(0, min(remaining, amount)); the
-- chargeable portion is the remainder (amount − allowance_consumed_pence).
--
-- Backfill: historical rows keep 0 (the precise split was not captured at the
-- time; on_free_allowance remains for those). New rows carry the exact figure.
--
-- Spec: docs/audits/allhaus-logic-economy-audit.md (F14).

ALTER TABLE public.read_events
  ADD COLUMN allowance_consumed_pence integer DEFAULT 0 NOT NULL;
