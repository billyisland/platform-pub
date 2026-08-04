-- 169: the free allowance a reader was GRANTED, stored on the reader.
--
-- `free_allowance_remaining_pence` records what is LEFT of the gift. What was
-- given was never recorded anywhere — it was the literal 500 in two INSERT
-- paths (gateway/src/lib/account-provision.ts, shared/src/auth/accounts.ts)
-- and the column DEFAULT below it. So the `free_allowance_pence` dial in
-- platform_config governed nothing at all: it had no reader in the codebase,
-- and retuning it changed neither what a new reader received nor what any
-- surface displayed. That is precisely the failure CLAUDE.md's tuning-dials
-- rule exists to prevent, and the second time it has happened to these dials
-- (see the loadConfig docblock on the f8c73e6 schema regeneration).
--
-- Storing the grant per reader is what makes the dial safe to retune. The
-- alternative — displaying the CURRENT dial as every reader's total — restates
-- history: a reader gifted £5 would be told they had been gifted £7.50 the
-- moment an operator moved the dial, on the Ledger gauge and on their account
-- statement's "Starting credit" line. The gift is a historical fact about that
-- reader ("the free allowance is a gift", and a gifted penny is charged to
-- nobody ever, including retroactively), so it belongs on their row.
--
-- The backfill is exact rather than approximate: every account that exists
-- today was granted 500, because both INSERT sites hardcoded it and the column
-- default was 500 for the whole history of the table. DEFAULT 500 therefore
-- fills existing rows with the truth, and is kept afterwards as the same kind
-- of in-step fallback loadConfig's own `int(map, 'free_allowance_pence', 500)`
-- is — a floor that matches the seeded default in config-defaults.sql, not a
-- second source of truth. Both INSERT paths now pass the dial explicitly.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS free_allowance_granted_pence integer DEFAULT 500 NOT NULL;

COMMENT ON COLUMN accounts.free_allowance_granted_pence IS
  'What this reader was gifted as their free allowance, stamped from the free_allowance_pence dial at signup. Historical fact — never restated when the dial is retuned. free_allowance_remaining_pence is what is left of it.';
