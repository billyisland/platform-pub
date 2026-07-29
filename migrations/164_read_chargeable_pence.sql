-- 164_read_chargeable_pence.sql
--
-- "Free reads should remain free — we can't charge people for stuff we gave
-- them as a gift." (product ruling, 2026-07-29)
--
-- THE BUG. `classifyRead` (F14, 2026-07-06) models the free-allowance split
-- precisely: `allowance_consumed_pence` is the portion of a read genuinely
-- covered by the £5 gift, and its own comment says the chargeable portion is
-- "the remainder (amount − allowanceConsumedPence) — recorded implicitly …
-- lets a future settlement write-off compute against real numbers". That
-- write-off was never built. `convertProvisionalReads` (accrual.ts) instead
-- flips every provisional read to 'accrued' at the FULL `amount_pence` and
-- debits the tab for all of it — so a reader who read on the house and later
-- attached a card was retroactively charged for the gift, and the writer
-- accrued on pence nobody ever paid.
--
-- THE FIX. Make "what the reader owes for this read" a first-class, derived
-- quantity, and route every money query through it:
--
--   chargeable_pence = amount_pence − allowance_consumed_pence
--
-- `amount_pence` keeps meaning exactly what it always meant — the article's
-- list price at read time — so nothing is lost and no column changes meaning
-- depending on row state. GENERATED … STORED so it cannot drift from its
-- inputs and no writer has to remember to maintain it.
--
-- WHY THIS IS A NO-OP OUTSIDE THE GIFTED POPULATION. `classifyRead` sets
-- `allowanceConsumedPence = hasCard ? 0 : max(0, min(remaining, amount))`, so
-- every read by a card-holding reader has allowance_consumed_pence = 0 and
-- therefore chargeable_pence == amount_pence identically. Only card-less
-- (provisional) reads can differ, and those earn nothing until converted. The
-- companion code change is thus behaviour-preserving for all existing money,
-- which is what makes a 30-site sweep of the payout core safe to ship at once.
-- The post-migration assertion at the foot of this file states it as SQL.
--
-- NOT RETROACTIVE. Reads already converted and charged under the old rule are
-- deliberately left alone: their tab debits, `writer_accrual` entries and
-- payouts have all settled, and rewriting them would break both the reader
-- parity invariant (−SUM(ledger) == reading_tabs.balance_pence) and
-- ledger_writer_earned. Whether to refund that population is a business
-- decision, not a migration; see docs/audits/FIX-PROGRAMME.md.

-- ── step 1: repair the pre-F14 legacy shape ─────────────────────────────────
-- Before F14 (2026-07-06) the allowance was a coarse boolean: `on_free_allowance`
-- TRUE meant "the WHOLE read is on allowance", and `allowance_consumed_pence`
-- did not exist (it landed with DEFAULT 0). Those rows therefore look like
-- "gifted nothing" to the formula above, and would be charged in full on
-- conversion — precisely the bug this migration closes.
--
-- Post-F14 rows cannot be confused with them: `onFreeAllowance` is now derived
-- as `allowanceConsumedPence > 0`, so (on_free_allowance AND consumed = 0) is
-- unreachable under current code and identifies the legacy rows exactly.
--
-- Scoped to 'provisional' ON PURPOSE. A legacy row that already converted was
-- already charged and already earned its writer; see NOT RETROACTIVE above.
UPDATE read_events
   SET allowance_consumed_pence = amount_pence
 WHERE on_free_allowance = TRUE
   AND allowance_consumed_pence = 0
   AND state = 'provisional';

-- ── step 2: the derived column ──────────────────────────────────────────────
-- Non-negative by construction: allowanceConsumedPence = min(remaining, amount)
-- is capped at `amount`, and step 1 sets it to exactly `amount`. A CHECK would
-- be redundant against a GENERATED expression whose inputs are already bounded.
ALTER TABLE read_events
  ADD COLUMN chargeable_pence integer
  GENERATED ALWAYS AS (amount_pence - allowance_consumed_pence) STORED;

COMMENT ON COLUMN read_events.chargeable_pence IS
  'What the reader owes for this read and what the writer earns on: list price minus the free-allowance gift. Every money query uses this; amount_pence is the list price only (migration 164).';

COMMENT ON COLUMN read_events.amount_pence IS
  'The article''s list price at read time. NOT what is charged — see chargeable_pence (migration 164).';

-- Partial index for the gifted population: small, and the only way to ask
-- "which reads were given away" without a seq scan over every read ever.
CREATE INDEX idx_read_events_gifted
  ON read_events (reader_id, read_at)
  WHERE allowance_consumed_pence > 0;

-- ── assertion: the change is inert for everything already charged ───────────
-- Every read that has left 'provisional' must have chargeable == amount, or the
-- companion code sweep would silently restate settled money. Fails the
-- migration loudly rather than shipping a divergence.
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM read_events
   WHERE state <> 'provisional'
     AND allowance_consumed_pence <> 0;
  IF n > 0 THEN
    RAISE EXCEPTION
      'Migration 164: % already-charged read(s) carry a non-zero allowance_consumed_pence. Switching the money path to chargeable_pence would restate settled money. Resolve these rows before migrating (see NOT RETROACTIVE in this file).', n;
  END IF;
END $$;
