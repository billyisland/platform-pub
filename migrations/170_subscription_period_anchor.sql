-- =============================================================================
-- 170 — subscriptions.period_anchor_day
--
-- The renewal worker advanced each period from the PREVIOUS period end with
-- setUTCMonth, which overflows rather than clamps: 31 Jan + 1 month → 3 Mar,
-- and the next cycle then advanced 3 Mar. A subscriber who signed up on the
-- 31st walked forward a few days every month. Anchoring cannot be inferred
-- from the stored dates — once a period end has been clamped to 28 February
-- there is nothing left in the row that says the subscription hangs off the
-- 31st — so the anchor becomes a stored fact about the subscription.
--
-- BACKFILL — deliberately the CURRENT period start, not started_at. For a
-- subscription that has never drifted the two agree. For one that has, taking
-- started_at would RESTORE the original day and push an existing subscriber's
-- next renewal later than the date they have already been told; taking the
-- current period start freezes the drift where it is and stops it growing.
-- Correcting history is a refund question, not a migration.
--
-- NOT NULL with no default: every write path supplies the anchor explicitly
-- (gateway/src/routes/subscriptions/*, subscription-expiry.ts), and a column
-- default would let a new path silently inherit "the 1st" instead of failing.
-- =============================================================================

ALTER TABLE subscriptions
  ADD COLUMN period_anchor_day SMALLINT;

UPDATE subscriptions
   SET period_anchor_day = EXTRACT(DAY FROM current_period_start AT TIME ZONE 'UTC')::smallint;

ALTER TABLE subscriptions
  ALTER COLUMN period_anchor_day SET NOT NULL;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_period_anchor_day_check
  CHECK (period_anchor_day BETWEEN 1 AND 31);

COMMENT ON COLUMN subscriptions.period_anchor_day IS
  'Day-of-month (UTC, 1..31) the subscription''s renewal periods are anchored to. Each advance lands on this day in the target month, clamped to that month''s last day — so anchor 31 gives 31 Jan → 28 Feb → 31 Mar, never a walk. Set from the subscribe/re-activate moment; never recomputed from a clamped period end.';
